# frozen_string_literal: true

require "optparse"

module RuntimeVisualizer
  # The runtime-visualizer executable.
  #
  #   runtime-visualizer trace [options] script.rb [args...]
  #   runtime-visualizer inspect trace.rvtrace
  #   runtime-visualizer stats trace.rvtrace
  #   runtime-visualizer export --perfetto trace.rvtrace [-o out.json]
  class CLI
    USAGE = <<~TEXT
      Usage: runtime-visualizer <command> [options]

      Commands:
        trace [options] SCRIPT [ARGS...]   run SCRIPT with the recorder attached
        inspect TRACE                      print the events of a trace as a table
        stats TRACE                        print recorder statistics of a trace
        export --perfetto TRACE            convert a trace to Perfetto/Chrome JSON

      Run `runtime-visualizer <command> --help` for the options of a command.
    TEXT

    def self.run(argv, out: $stdout, err: $stderr)
      new(out, err).run(argv)
    end

    def initialize(out, err)
      @out = out
      @err = err
    end

    def run(argv)
      command, *rest = argv
      case command
      when "trace" then trace(rest)
      when "inspect" then inspect_trace(rest)
      when "stats" then stats(rest)
      when "export" then export(rest)
      when "version", "--version", "-v" then @out.puts("runtime-visualizer #{VERSION}")
      when nil, "help", "--help", "-h" then @out.puts(USAGE)
      else
        @err.puts("unknown command #{command.inspect}\n\n#{USAGE}")
        1
      end || 0
    end

    private

    def trace(argv)
      options = { output: nil, gc_events: true, probes: Recorder::DEFAULT_PROBES.dup, source_lines: false,
                  drain_interval: nil, buffer_capacity: Native::DEFAULT_BUFFER_CAPACITY }
      parser = OptionParser.new do |o|
        o.banner = "Usage: runtime-visualizer trace [options] SCRIPT [ARGS...]"
        o.on("-o", "--output PATH", "trace file (default: SCRIPT name with .rvtrace)") { |v| options[:output] = v }
        o.on("--lines", "record source lines through TracePoint (high overhead)") do
          options[:source_lines] = true
          options[:drain_interval] ||= 0.05
        end
        o.on("--drain-interval SECONDS", Float, "drain the ring from a background thread every N seconds") { |v| options[:drain_interval] = v }
        o.on("--no-gc", "do not record GC enter/exit") { options[:gc_events] = false }
        o.on("--no-sleep-probe", "do not observe Kernel#sleep") { options[:probes].delete(:sleep) }
        o.on("--no-mutex-probe", "do not observe Thread::Mutex") { options[:probes].delete(:mutex) }
        o.on("--buffer N", Integer, "ring buffer capacity in events (default #{options[:buffer_capacity]})") { |v| options[:buffer_capacity] = v }
      end
      script, *script_args = parser.parse(argv)
      return usage_error(parser) unless script

      output = options.delete(:output) || default_output_for(script)
      run_script(script, script_args, output, options)
      @err.puts("trace written to #{output}")
      0
    end

    def run_script(script, script_args, output, options)
      path = File.expand_path(script)
      recorder = Recorder.new(output, script: script, **options)
      recorder.start
      begin
        ARGV.replace(script_args)
        $0 = path
        load(path)
      rescue SystemExit
        # the script called exit; the trace is still worth keeping
      ensure
        recorder.stop
      end
    end

    def inspect_trace(argv)
      trace = load_trace(argv) or return 1
      timeline = Timeline.new(trace)
      @out.puts(format("%-12s %-14s %-9s %-22s %-38s %s", "time", "ruby_thread", "native", "event", "cruby event", "source"))
      trace.events.each do |event|
        @out.puts(format("%9.3f ms %-14s %-9s %-22s %-38s %s", trace.relative_ns(event.timestamp_ns) / 1e6,
                         trace.thread_label(event.ruby_thread_id), event.native_thread_id, event.type,
                         event.native_event || "-", event.source))
      end
      @out.puts
      print_threads(trace, timeline)
      print_violations(timeline)
      0
    end

    def stats(argv)
      trace = load_trace(argv) or return 1
      stats = trace.stats
      @out.puts("Ruby #{trace.header['ruby_version']} pid #{trace.header['process_id']} channels: #{trace.channels.join(', ')}")
      %w[events_recorded events_dropped buffer_high_water_mark buffer_capacity threads_seen threads_unidentified drain_count].each do |key|
        @out.puts(format("  %-24s %s", key, stats[key]))
      end
      @out.puts(format("  %-24s %.3f ms", "tracing_duration", stats.fetch("tracing_duration_ns", trace.duration_ns) / 1e6))
      @out.puts("  incomplete trace: no end record") unless trace.complete?
      0
    end

    def export(argv)
      options = { format: nil, output: nil }
      parser = OptionParser.new do |o|
        o.banner = "Usage: runtime-visualizer export --perfetto TRACE [-o OUT]"
        o.on("--perfetto", "Chrome Trace Event JSON for ui.perfetto.dev") { options[:format] = :perfetto }
        o.on("--ndjson", "canonical .rvtrace, rewritten with a complete tail") { options[:format] = :ndjson }
        o.on("-o", "--output PATH", "output file (default: stdout)") { |v| options[:output] = v }
      end
      rest = parser.parse(argv)
      trace = load_trace(rest) or return 1
      return usage_error(parser, "choose --perfetto or --ndjson") unless options[:format]

      with_output(options[:output]) do |io|
        case options[:format]
        when :perfetto then Exporters::Perfetto.new(trace).export(io)
        when :ndjson then Exporters::Ndjson.export(trace, io)
        end
      end
      0
    end

    def print_threads(trace, timeline)
      @out.puts("threads:")
      timeline.ruby_thread_ids.each do |id|
        info = trace.thread(id)
        running = timeline.thread_segments[id].select { |s| s.state == Timeline::RUNNING }.sum(&:duration_ns)
        @out.puts(format("  %-14s id=%-3d native=%-20s running=%.3f ms", trace.thread_label(id), id,
                         (info&.native_thread_ids || []).join(","), running / 1e6))
      end
    end

    def print_violations(timeline)
      return if timeline.violations.empty?

      @out.puts("model violations (unexpected event sequences, see docs/limitations.md):")
      timeline.violations.each { |v| @out.puts("  seq #{v.sequence} thread #{v.ruby_thread_id}: #{v.message}") }
    end

    def load_trace(argv)
      path = argv.first
      return usage_error(nil, "trace file required") && nil unless path
      return (@err.puts("no such file: #{path}") && nil) unless File.exist?(path)

      Trace.load(path)
    end

    def default_output_for(script) = "#{File.basename(script, '.rb')}.rvtrace"

    def with_output(path)
      if path
        File.open(path, "w") { |io| yield io }
        @err.puts("written to #{path}")
      else
        yield @out
      end
    end

    def usage_error(parser, message = nil)
      @err.puts(message) if message
      @err.puts(parser) if parser
      1
    end
  end
end
