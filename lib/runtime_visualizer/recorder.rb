# frozen_string_literal: true

module RuntimeVisualizer
  # A recording session: starts the native recorder, keeps the probes in
  # step with it, drains the ring into an .rvtrace file, and closes the file
  # with thread names and statistics.
  #
  #   RuntimeVisualizer::Recorder.trace("out.rvtrace") do
  #     work
  #   end
  #
  # Only one session can be active per process; the hooks are global.
  class Recorder
    DEFAULT_PROBES = %i[sleep mutex].freeze
    DRAIN_BATCH = 100_000
    DRAIN_THREAD_NAME = "runtime_visualizer.drain"

    class << self
      attr_reader :current

      def trace(output, **options)
        recorder = new(output, **options)
        recorder.start
        begin
          yield recorder
        ensure
          recorder.stop
        end
      end
    end

    attr_reader :output, :threads, :channels, :options

    # drain_interval: seconds between background drains, or nil to drain only
    # at stop. A background drain needs a Ruby thread of its own, which then
    # shows up in the trace; its id is written to the header so viewers can
    # hide it. It is the only way to keep up with the volume produced by
    # source line tracing.
    def initialize(output, buffer_capacity: Native::DEFAULT_BUFFER_CAPACITY, gc_events: true,
                   probes: DEFAULT_PROBES, source_lines: false, drain_interval: nil, script: nil)
      @output = output
      @options = { buffer_capacity: buffer_capacity, gc_events: gc_events, probes: probes,
                   source_lines: source_lines, drain_interval: drain_interval, script: script }
      @threads = ThreadRegistry.new
      @probes = build_probes(probes, source_lines)
      @source_lines = @probes.grep(Probes::SourceLines).first
      @drain_lock = Thread::Mutex.new
      @normalizer = Normalizer.new
      @channels = [EventTypes::CRUBY_THREAD, EventTypes::RECORDER]
      @channels << EventTypes::CRUBY_GC if gc_events
      @channels.concat(@probes.map(&:channel))
      @active = false
    end

    def active? = @active

    def start
      raise ArgumentError, "a recorder is already active in this process" if self.class.current

      @writer = TraceWriter.open(output)
      Native.start(options[:buffer_capacity], options[:gc_events] ? Native::OPT_GC_EVENTS : 0)
      @active = true
      self.class.instance_variable_set(:@current, self)
      ForkGuard.install

      @threads.snapshot
      @drain_lock.synchronize do
        start_drain_thread if options[:drain_interval]
        @writer.header(header_fields)
        @writer.flush
      end
      # Probes go last so the recorder's own setup does not show up as traced lines.
      @probes.each(&:enable)
      self
    end

    # Moves everything the ring holds into the file. Safe to call from any
    # thread; the recorder's own Ruby code is kept out of the line channel
    # while it runs so a trace does not fill up with the tracer tracing itself.
    def drain
      @drain_lock.synchronize do
        paused { drain_ring }
        @threads.snapshot
        @writer.flush
      end
    end

    def stop
      return unless active?

      stop_drain_thread
      @probes.each(&:disable)
      Native.stop
      @active = false
      self.class.instance_variable_set(:@current, nil)

      drain
      write_tail
      @writer.close
      self
    end

    def stats = Native.stats

    # Runs the block (the actual fork) while no drain is in progress, so the
    # child never inherits a half-written batch in the file's write buffer.
    def around_fork(&block)
      @drain_lock.synchronize(&block)
    end

    # In the child after fork: the inherited hooks are neutralised by the
    # extension; here the session either continues into a new file or ends.
    def child_forked
      Native.reset_after_fork
      @active = false
      self.class.instance_variable_set(:@current, nil)
      @probes.each(&:disable)
      @writer = nil

      return unless output.is_a?(String)

      child = self.class.new(child_output_path, **options)
      child.start
      at_exit { child.stop }
    end

    private

    def drain_ring
      loop do
        raw = Native.drain(DRAIN_BATCH)
        break if raw.empty?

        @normalizer.each_event(raw) do |event|
          @threads.observe(event)
          @writer.event(event)
        end
      end
    end

    def paused(&block)
      @source_lines ? @source_lines.paused(&block) : yield
    end

    # The drain thread is never killed: a kill in the middle of a batch would
    # lose events that were already taken out of the ring. It is asked to
    # stop, woken up, and joined.
    def start_drain_thread
      @drain_thread_stop = false
      serial = Thread::Queue.new
      @drain_thread = Thread.new do
        # On 3.2 a thread's serial can only be read from the thread itself.
        serial << Native.current_thread_serial
        until @drain_thread_stop
          sleep options[:drain_interval]
          drain unless @drain_thread_stop
        end
      end
      @drain_thread.name = DRAIN_THREAD_NAME
      @source_lines&.ignore_thread(@drain_thread)
      @drain_thread_id = serial.pop
      @drain_thread_id = nil if @drain_thread_id.zero?
    end

    def stop_drain_thread
      return unless @drain_thread

      @drain_thread_stop = true
      @drain_thread.wakeup
      @drain_thread.join
      @drain_thread = nil
    end

    def build_probes(names, source_lines)
      probes = names.map do |name|
        case name
        when :sleep then Probes::Sleep.new
        when :mutex then Probes::Mutex.new
        else raise ArgumentError, "unknown probe #{name.inspect}"
        end
      end
      probes << Probes::SourceLines.new if source_lines
      probes
    end

    def header_fields
      {
        "process_id" => Process.pid,
        "ruby_version" => RUBY_VERSION,
        "ruby_engine" => RUBY_ENGINE,
        "ruby_platform" => RUBY_PLATFORM,
        "clock" => "CLOCK_MONOTONIC",
        "clock_unit" => "ns",
        "trace_start_ns" => Native.stats[:started_at_ns],
        "scheduler" => scheduler_fields,
        "channels" => channels,
        "buffer_capacity" => Native.stats[:buffer_capacity],
        "script" => options[:script],
        "recorder_version" => VERSION,
        "recorder_thread_id" => @drain_thread_id
      }.compact
    end

    def scheduler_fields
      fields = { "mn_threads" => ENV["RUBY_MN_THREADS"] == "1" }
      fields["timeslice_env"] = ENV["RUBY_THREAD_TIMESLICE"] if ENV.key?("RUBY_THREAD_TIMESLICE")
      fields
    end

    def write_tail
      @threads.to_records.each { |record| @writer.thread(record) }
      @probes.grep(Probes::SourceLines).each do |probe|
        probe.source_files.each { |file| @writer.source_file(**file) }
      end
      native = Native.stats
      @writer.stats(
        "events_recorded" => native[:events_recorded],
        "events_dropped" => native[:events_dropped],
        "buffer_high_water_mark" => native[:buffer_high_water_mark],
        "buffer_capacity" => native[:buffer_capacity],
        "threads_seen" => native[:threads_seen],
        "threads_unidentified" => native[:threads_unidentified],
        "tracing_duration_ns" => native[:stopped_at_ns] - native[:started_at_ns],
        "drain_count" => native[:drain_count]
      )
      @writer.finish(trace_end_ns: native[:stopped_at_ns])
    end

    def child_output_path
      base = output.sub(/\.rvtrace\z/, "")
      "#{base}.pid#{Process.pid}.rvtrace"
    end

    # Process._fork is the documented hook for libraries that need to know
    # about fork (Ruby 3.1+). The child gets a copy of the ring and of the
    # hook registration; see rv_recorder_reset_after_fork for why the hook is
    # not removed there.
    module ForkGuard
      def _fork
        recorder = Recorder.current
        pid = recorder ? recorder.around_fork { super() } : super
        recorder.child_forked if recorder && pid.zero?
        pid
      end

      def self.install
        return if @installed

        Process.singleton_class.prepend(self)
        @installed = true
      end
    end
  end
end
