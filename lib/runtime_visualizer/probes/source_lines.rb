# frozen_string_literal: true

module RuntimeVisualizer
  module Probes
    # Records the source line each thread is executing, through
    # TracePoint(:line). Runs with the GVL, on the thread that executes
    # the line.
    #
    # This is the expensive channel. Every line executed becomes an event,
    # the GVL stays busier, and timeslices expire at different points than
    # they would have. It is off by default and the header lists it when
    # on, so a reader knows the schedule was perturbed.
    #
    # Line events only say where a thread *was* when it held the GVL. They
    # never imply anything about the GVL itself; correlation with scheduler
    # events happens downstream.
    class SourceLines
      SOURCE_LINE = EventTypes.code(:SOURCE_LINE)
      MAX_EMBEDDED_BYTES = 256 * 1024

      attr_reader :paths

      def initialize(ignore: [])
        @ignore = [RuntimeVisualizer::LIB_DIR, *ignore]
        @ignored_threads = []
        @paths = {}
        @tracepoint = TracePoint.new(:line) { |tp| record(tp) }
      end

      # Lines executed by this thread are not recorded (the recorder's own
      # drain thread, typically).
      def ignore_thread(thread)
        @ignored_threads << thread
      end

      def channel = "tracepoint:line"

      def enable = @tracepoint.enable
      def disable = @tracepoint.disable


      def source_files
        @paths.map do |path, id|
          { id: id, path: path, content: readable?(path) ? File.read(path) : nil }
        end
      end

      private

      def record(tp)
        return if @ignored_threads.include?(Thread.current) || Probes.silenced?

        path = tp.path
        return if path.start_with?("<internal:") || @ignore.any? { |dir| path.start_with?(dir) }

        Native.mark(SOURCE_LINE, id_for(path), tp.lineno)
      end

      def id_for(path)
        @paths[path] ||= @paths.size + 1
      end

      def readable?(path)
        File.file?(path) && File.size(path) <= MAX_EMBEDDED_BYTES
      end
    end
  end
end
