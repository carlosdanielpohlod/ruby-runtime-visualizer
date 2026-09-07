# frozen_string_literal: true

module RuntimeVisualizer
  module Probes
    SILENCED_KEY = :runtime_visualizer_probes_silenced

    # Runs the block with every probe muted on the calling thread, so the
    # recorder's own locks and sleeps do not show up in the trace.
    def self.silence
      previous = Thread.current[SILENCED_KEY]
      Thread.current[SILENCED_KEY] = true
      yield
    ensure
      Thread.current[SILENCED_KEY] = previous
    end

    def self.silenced? = Thread.current[SILENCED_KEY] == true

    # Observes calls to Kernel#sleep from Ruby, with the GVL held.
    #
    # CRuby's thread hooks report that a thread released the GVL, not why.
    # This probe records the boundaries of the sleep call so that the model
    # can label a SUSPENDED interval that falls between them as SLEEPING.
    # That label is derived: the scheduler never said "sleeping".
    #
    # Implemented by prepending a module to Kernel. Calls written as
    # `sleep 1` resolve through Object → prepended module → Kernel, so they
    # are seen. `Kernel.sleep(1)` with an explicit receiver goes through the
    # singleton method and is not.
    class Sleep
      ENTER = EventTypes.code(:SLEEP_ENTER)
      EXIT = EventTypes.code(:SLEEP_EXIT)
      MAX_ARG = (2**32) - 1

      module KernelExtension
        private

        def sleep(*args)
          return super unless Probes::Sleep.enabled? && !Probes.silenced?

          Native.mark(Probes::Sleep::ENTER, Probes::Sleep.requested_us(args.first), 0)
          begin
            super
          ensure
            Native.mark(Probes::Sleep::EXIT, 0, 0)
          end
        end
      end

      @enabled = false
      @installed = false

      class << self
        def enabled? = @enabled

        # Microseconds fit 32 bits up to 71 minutes and keep sub-millisecond
        # sleeps distinguishable from `sleep` with no argument (0).
        def requested_us(duration)
          return 0 unless duration.is_a?(Numeric)

          (duration * 1_000_000).round.clamp(1, MAX_ARG)
        end

        def install
          return if @installed

          Kernel.prepend(KernelExtension)
          @installed = true
        end
      end

      def channel = "probe:sleep"

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
