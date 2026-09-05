# frozen_string_literal: true

module RuntimeVisualizer
  module Probes
    # Observes Thread::Mutex lock/unlock boundaries from Ruby, with the GVL.
    #
    # A `gvl_released` that happens between `mutex_lock_wait` and
    # `mutex_acquired` on the same thread is, by a documented rule, "waiting
    # for that mutex". The thread hooks themselves carry no such reason.
    #
    # Known blind spots, by construction:
    # - Mutex#synchronize is implemented in C and calls the lock function
    #   directly, bypassing method dispatch. It is re-implemented here in
    #   terms of lock/unlock so it is observed; the semantics are the same
    #   except for very unusual interrupt timing.
    # - ConditionVariable#wait releases and re-acquires the mutex inside C.
    #   Those transitions are not seen.
    # - Monitor is a separate C implementation and is not probed.
    class Mutex
      LOCK_WAIT = EventTypes.code(:MUTEX_LOCK_WAIT)
      ACQUIRED = EventTypes.code(:MUTEX_ACQUIRED)
      RELEASED = EventTypes.code(:MUTEX_RELEASED)

      module MutexExtension
        def lock
          return super unless Probes::Mutex.enabled?

          id = Probes::Mutex.id_of(self)
          Native.mark(Probes::Mutex::LOCK_WAIT, id, 0)
          super
          Native.mark(Probes::Mutex::ACQUIRED, id, 0)
          self
        end

        def try_lock
          acquired = super
          Native.mark(Probes::Mutex::ACQUIRED, Probes::Mutex.id_of(self), 0) if acquired && Probes::Mutex.enabled?
          acquired
        end

        def unlock
          result = super
          Native.mark(Probes::Mutex::RELEASED, Probes::Mutex.id_of(self), 0) if Probes::Mutex.enabled?
          result
        end

        def synchronize
          return super unless Probes::Mutex.enabled?

          lock
          begin
            yield
          ensure
            unlock
          end
        end
      end

      @enabled = false
      @installed = false

      class << self
        def enabled? = @enabled

        # object_id is a small, process-unique integer in CRuby; the low 32
        # bits travel through the native event and readers map them back to
        # a display id.
        def id_of(mutex) = mutex.object_id & 0xFFFFFFFF

        def install
          return if @installed

          Thread::Mutex.prepend(MutexExtension)
          @installed = true
        end
      end

      def channel = "probe:mutex"

      def enable
        self.class.install
        self.class.instance_variable_set(:@enabled, true)
      end

      def disable
        self.class.instance_variable_set(:@enabled, false)
      end
    end
  end
end
