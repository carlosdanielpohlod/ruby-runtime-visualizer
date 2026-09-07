# frozen_string_literal: true

module RuntimeVisualizer
  # The table that turns a native type code into protocol vocabulary.
  #
  # Every entry says where the event came from, which is the whole point:
  # "gvl_acquired" is a friendlier name, but the reader must always be able
  # to get back to RUBY_INTERNAL_THREAD_EVENT_RESUMED.
  module EventTypes
    Definition = Data.define(:code, :type, :native_event, :source, :channel) do
      def recorder? = source == "recorder"
      def scheduler? = source == "cruby_internal_thread_event"
      def gc? = source == "cruby_gc_tracepoint"
      def probe? = source == "probe"
    end

    CRUBY_THREAD = "cruby_internal_thread_event"
    CRUBY_GC = "cruby_gc_tracepoint"
    PROBE = "probe"
    TRACEPOINT = "tracepoint"
    RECORDER = "recorder"

    DEFINITIONS = [
      Definition.new(1,  "tracing_started",      nil,                                    RECORDER,     "recorder"),
      Definition.new(2,  "tracing_stopped",      nil,                                    RECORDER,     "recorder"),
      Definition.new(3,  "events_dropped",       nil,                                    RECORDER,     "recorder"),
      Definition.new(4,  "threads_unidentified", nil,                                    RECORDER,     "recorder"),

      Definition.new(10, "thread_started",       "RUBY_INTERNAL_THREAD_EVENT_STARTED",   CRUBY_THREAD, CRUBY_THREAD),
      Definition.new(11, "wants_gvl",            "RUBY_INTERNAL_THREAD_EVENT_READY",     CRUBY_THREAD, CRUBY_THREAD),
      Definition.new(12, "gvl_acquired",         "RUBY_INTERNAL_THREAD_EVENT_RESUMED",   CRUBY_THREAD, CRUBY_THREAD),
      Definition.new(13, "gvl_released",         "RUBY_INTERNAL_THREAD_EVENT_SUSPENDED", CRUBY_THREAD, CRUBY_THREAD),
      Definition.new(14, "thread_exited",        "RUBY_INTERNAL_THREAD_EVENT_EXITED",    CRUBY_THREAD, CRUBY_THREAD),

      Definition.new(20, "gc_enter",             "RUBY_INTERNAL_EVENT_GC_ENTER",         CRUBY_GC,     CRUBY_GC),
      Definition.new(21, "gc_exit",              "RUBY_INTERNAL_EVENT_GC_EXIT",          CRUBY_GC,     CRUBY_GC),

      Definition.new(30, "sleep_enter",          "Kernel#sleep",                         PROBE,        "probe:sleep"),
      Definition.new(31, "sleep_exit",           "Kernel#sleep",                         PROBE,        "probe:sleep"),
      Definition.new(32, "mutex_lock_wait",      "Thread::Mutex#lock",                   PROBE,        "probe:mutex"),
      Definition.new(33, "mutex_acquired",       "Thread::Mutex#lock",                   PROBE,        "probe:mutex"),
      Definition.new(34, "mutex_released",       "Thread::Mutex#unlock",                 PROBE,        "probe:mutex"),

      Definition.new(40, "source_line",          "TracePoint :line",                     TRACEPOINT,   "tracepoint:line")
    ].freeze

    BY_CODE = DEFINITIONS.to_h { |d| [d.code, d] }.freeze
    BY_TYPE = DEFINITIONS.to_h { |d| [d.type, d] }.freeze

    # Codes the extension exposes, so a mismatch between C and Ruby is caught
    # at load time instead of showing up as a mislabelled trace.
    NATIVE_NAMES = {
      1 => :TRACING_STARTED, 2 => :TRACING_STOPPED, 3 => :EVENTS_DROPPED, 4 => :THREADS_UNIDENTIFIED,
      10 => :THREAD_STARTED, 11 => :THREAD_READY, 12 => :THREAD_RESUMED, 13 => :THREAD_SUSPENDED, 14 => :THREAD_EXITED,
      20 => :GC_ENTER, 21 => :GC_EXIT,
      30 => :SLEEP_ENTER, 31 => :SLEEP_EXIT, 32 => :MUTEX_LOCK_WAIT, 33 => :MUTEX_ACQUIRED, 34 => :MUTEX_RELEASED,
      40 => :SOURCE_LINE
    }.freeze

    # An event type this version does not know. Readers keep it, treat it as
    # belonging to no channel, and show it as-is.
    UNKNOWN = Definition.new(0, "unknown", nil, "unknown", "unknown").freeze

    def self.code(name) = NATIVE_NAMES.key(name) || raise(ArgumentError, "unknown event #{name}")

    def self.definition(type) = BY_TYPE.fetch(type, UNKNOWN)

    def self.verify_against_native!(native_types)
      NATIVE_NAMES.each do |code, name|
        next if native_types[name] == code

        raise LoadError, "native extension reports #{name}=#{native_types[name].inspect}, Ruby expects #{code}"
      end
    end
  end
end
