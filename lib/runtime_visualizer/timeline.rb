# frozen_string_literal: true

module RuntimeVisualizer
  # Derives thread state intervals and GVL ownership from a trace, following
  # the rules in docs/event-protocol.md ("Thread state model"). The web UI
  # implements the same rules in TypeScript; this is the reference used by
  # the CLI and the tests.
  class Timeline
    Segment = Data.define(:ruby_thread_id, :state, :start_ns, :end_ns, :precision, :native_event, :sequence) do
      def duration_ns = end_ns - start_ns
    end

    GvlSegment = Data.define(:owner, :start_ns, :end_ns, :precision) do
      def idle? = owner.nil?
      def duration_ns = end_ns - start_ns
    end

    Violation = Data.define(:sequence, :ruby_thread_id, :message)

    STARTED = "STARTED"
    WANTS_GVL = "WANTS_GVL"
    RUNNING = "RUNNING"
    SUSPENDED = "SUSPENDED"
    PREEMPTED = "PREEMPTED"
    SLEEPING = "SLEEPING"
    WAITING_MUTEX = "WAITING_MUTEX"
    EXITED = "EXITED"
    UNKNOWN = "UNKNOWN"

    TRANSITIONS = {
      "thread_started" => STARTED,
      "wants_gvl" => WANTS_GVL,
      "gvl_acquired" => RUNNING,
      "gvl_released" => SUSPENDED,
      "thread_exited" => EXITED
    }.freeze

    attr_reader :trace, :violations

    def initialize(trace)
      @trace = trace
      @violations = []
      build
    end

    # Hash of ruby_thread_id => [Segment], each list ordered by time.
    attr_reader :thread_segments

    # [GvlSegment] covering the trace, idle gaps included.
    attr_reader :gvl_segments

    def ruby_thread_ids = @thread_segments.keys.sort

    def state_at(ruby_thread_id, timestamp_ns)
      @thread_segments.fetch(ruby_thread_id, []).find { |s| s.start_ns <= timestamp_ns && timestamp_ns < s.end_ns }&.state
    end

    def gvl_owner_at(timestamp_ns)
      @gvl_segments.find { |s| s.start_ns <= timestamp_ns && timestamp_ns < s.end_ns }&.owner
    end

    private

    Open = Struct.new(:state, :start_ns, :precision, :native_event, :sequence)

    def build
      @thread_segments = Hash.new { |h, k| h[k] = [] }
      @gvl_segments = []
      open = {}
      gvl_owner = nil
      gvl_since = trace.trace_start_ns

      trace.events.each do |event|
        id = event.ruby_thread_id
        next if id.zero?

        if event.type == "tracing_started"
          # The thread that started tracing held the GVL to do so.
          open[id] = Open.new(RUNNING, event.timestamp_ns, Precision::OBSERVED, nil, event.sequence)
          gvl_owner = id
          gvl_since = event.timestamp_ns
          next
        end
        next unless event.scheduler?

        state = TRANSITIONS.fetch(event.type)
        open[id] ||= infer_initial(event)

        case event.type
        when "gvl_acquired"
          if gvl_owner && gvl_owner != id
            # Another thread got the lock without this owner reporting a
            # release: 3.2 timeslice preemption looks like this. Close the
            # owner's RUNNING and mark the gap until it speaks again.
            close(open, gvl_owner, event.timestamp_ns)
            open[gvl_owner] = Open.new(PREEMPTED, event.timestamp_ns, Precision::DERIVED, nil, event.sequence)
          elsif gvl_owner == id
            @violations << Violation.new(event.sequence, id, "gvl_acquired while already the owner")
          end
          close_gvl(gvl_owner, gvl_since, event.timestamp_ns)
          gvl_owner = id
          gvl_since = event.timestamp_ns
        when "gvl_released", "thread_exited"
          if gvl_owner == id
            close_gvl(gvl_owner, gvl_since, event.timestamp_ns)
            gvl_owner = nil
            gvl_since = event.timestamp_ns
          end
        end

        transition(open, id, state, event)
      end

      end_ns = trace.end_ns
      open.each_key { |id| close(open, id, end_ns) }
      close_gvl(gvl_owner, gvl_since, end_ns)
      relabel_with_probes
      @thread_segments.each_value { |segments| segments.sort_by!(&:start_ns) }
    end

    def transition(open, id, state, event)
      current = open[id]
      # A repeated identical transition (3.2 emits SUSPENDED twice for sleep)
      # does not open a new segment.
      return if current && current.state == state && current.precision == Precision::OBSERVED

      close(open, id, event.timestamp_ns)
      open[id] = Open.new(state, event.timestamp_ns, Precision::OBSERVED, event.native_event, event.sequence)
    end

    def close(open, id, end_ns)
      current = open.delete(id)
      return unless current
      return if current.state == UNKNOWN && current.start_ns == end_ns

      @thread_segments[id] << Segment.new(
        ruby_thread_id: id, state: current.state, start_ns: current.start_ns, end_ns: end_ns,
        precision: current.precision, native_event: current.native_event, sequence: current.sequence
      )
    end

    def close_gvl(owner, since, until_ns)
      return if until_ns <= since

      @gvl_segments << GvlSegment.new(owner: owner, start_ns: since, end_ns: until_ns,
                                      precision: owner ? Precision::OBSERVED : Precision::DERIVED)
    end

    # A thread whose first event is not thread_started was alive before the
    # trace began. Its state until then is a guess, and labelled as such.
    def infer_initial(event)
      state = case event.type
              when "thread_started" then return nil
              when "gvl_released" then RUNNING
              when "wants_gvl" then SUSPENDED
              else UNKNOWN
              end
      Open.new(state, trace.trace_start_ns, Precision::INFERRED, nil, 0)
    end

    # SUSPENDED intervals enclosed by probe boundaries on the same thread get
    # a reason. Everything else keeps the honest "SUSPENDED, reason unknown".
    def relabel_with_probes
      windows = probe_windows
      @thread_segments.each do |id, segments|
        segments.map! do |segment|
          next segment unless segment.state == SUSPENDED

          window = windows[id]&.find { |w| w[:start_ns] <= segment.start_ns && segment.end_ns <= w[:end_ns] }
          window ? segment.with(state: window[:state], precision: Precision::DERIVED) : segment
        end
      end
    end

    def probe_windows
      windows = Hash.new { |h, k| h[k] = [] }
      pending = {}
      trace.events.each do |event|
        next unless event.probe?

        id = event.ruby_thread_id
        case event.type
        when "sleep_enter" then pending[[id, :sleep]] = event.timestamp_ns
        when "sleep_exit"
          start = pending.delete([id, :sleep]) and windows[id] << { state: SLEEPING, start_ns: start, end_ns: event.timestamp_ns }
        when "mutex_lock_wait" then pending[[id, :mutex]] = event.timestamp_ns
        when "mutex_acquired"
          start = pending.delete([id, :mutex]) and windows[id] << { state: WAITING_MUTEX, start_ns: start, end_ns: event.timestamp_ns }
        end
      end
      windows
    end
  end
end
