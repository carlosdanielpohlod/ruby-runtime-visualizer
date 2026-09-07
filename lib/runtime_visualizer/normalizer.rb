# frozen_string_literal: true

module RuntimeVisualizer
  # Turns the flat integer tuples the extension hands out into Event objects.
  #
  # Everything the extension does not know but the Ruby side can determine
  # is attached here: which native thread the callback is known to have run
  # on, the ractor, and probe payload decoding.
  class Normalizer
    FIELDS = Native::FIELDS_PER_EVENT

    # Which native thread executed the callback, relative to the Ruby thread
    # the event is about. From reading thread_pthread.c for each version;
    # see docs/research.md section 2.
    def self.native_thread_role(definition)
      return "self" unless Native::THREAD_IDENTITY_ATTACHED_TO_THREAD
      return "self" unless definition.scheduler?

      case definition.type
      when "thread_started" then "creator"
      when "wants_gvl" then "unknown"
      else "self"
      end
    end

    def initialize
      @roles = EventTypes::DEFINITIONS.to_h { |d| [d.code, self.class.native_thread_role(d)] }
    end

    def each_event(raw)
      ractor_id = single_ractor? ? 1 : nil
      raw.each_slice(FIELDS) do |sequence, timestamp_ns, ruby_thread, native_thread, code, arg0, arg1|
        definition = EventTypes::BY_CODE.fetch(code)
        yield Event.new(
          sequence: sequence,
          timestamp_ns: timestamp_ns,
          ruby_thread_id: ruby_thread,
          native_thread_id: native_thread,
          ractor_id: ractor_id,
          type: definition.type,
          native_event: definition.native_event,
          source: definition.source,
          precision: Precision::OBSERVED,
          metadata: metadata_for(definition, arg0, arg1)
        )
      end
    end

    private

    # ractor_id is not available inside the hooks. When the process has a
    # single ractor everything belongs to it; otherwise we say nothing.
    def single_ractor?
      !defined?(Ractor) || Ractor.count == 1
    end

    def metadata_for(definition, arg0, arg1)
      meta = { "native_thread_role" => @roles.fetch(definition.code) }
      case definition.type
      when "events_dropped", "threads_unidentified" then meta["count"] = arg0
      when "sleep_enter" then meta["requested_us"] = arg0.zero? ? nil : arg0
      when "mutex_lock_wait", "mutex_acquired", "mutex_released" then meta["mutex_id"] = arg0
      when "source_line"
        meta["path_id"] = arg0
        meta["line"] = arg1
      end
      meta
    end
  end
end
