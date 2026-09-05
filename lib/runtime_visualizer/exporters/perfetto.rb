# frozen_string_literal: true

require "json"

module RuntimeVisualizer
  module Exporters
    # Chrome Trace Event JSON, loadable at https://ui.perfetto.dev.
    #
    # This is an export *from* the protocol: the segments come from
    # Timeline, so the file shows the same derived states as the UI, and
    # the GVL lane is a separate track. A second "process" carries the
    # native-thread view, an idea borrowed from gvl-tracing, so that M:N
    # scheduling can be seen from the OS side.
    #
    # Format reference:
    # https://chromium.googlesource.com/catapult/+/refs/heads/main/docs/trace-event-format.md
    class Perfetto
      GVL_TID = 0
      NATIVE_VIEW_PID_OFFSET = 1_000_000

      def initialize(trace)
        @trace = trace
        @timeline = Timeline.new(trace)
        @pid = trace.header.fetch("process_id", 1)
      end

      def export(io)
        io.write(JSON.generate(events))
      end

      def events
        out = []
        out << meta("process_name", @pid, nil, "name" => "Ruby threads (#{@trace.header['ruby_version']})")
        out << meta("thread_name", @pid, GVL_TID, "name" => "GVL owner")
        out << meta("thread_sort_index", @pid, GVL_TID, "sort_index" => -1)

        @timeline.ruby_thread_ids.each do |id|
          out << meta("thread_name", @pid, id, "name" => @trace.thread_label(id))
          @timeline.thread_segments[id].each do |segment|
            out << complete(@pid, id, segment.state, segment.start_ns, segment.end_ns,
                            "precision" => segment.precision, "native_event" => segment.native_event)
          end
        end

        @timeline.gvl_segments.each do |segment|
          name = segment.idle? ? "idle" : @trace.thread_label(segment.owner)
          out << complete(@pid, GVL_TID, name, segment.start_ns, segment.end_ns, "precision" => segment.precision)
        end

        out.concat(native_view)
        out.concat(instants)
        out
      end

      private

      # Native-thread view: each RUNNING segment placed on the native thread
      # the Ruby thread was resumed on. Only RUNNING is shown because that is
      # the only state whose native thread is known for certain.
      def native_view
        pid = @pid + NATIVE_VIEW_PID_OFFSET
        out = [meta("process_name", pid, nil, "name" => "Native threads view")]
        resumed = @trace.events.select { |e| e.type == "gvl_acquired" }.to_h { |e| [e.sequence, e.native_thread_id] }
        @timeline.thread_segments.each_value do |segments|
          segments.each do |segment|
            next unless segment.state == Timeline::RUNNING

            tid = resumed[segment.sequence] or next
            out << complete(pid, tid, @trace.thread_label(segment.ruby_thread_id), segment.start_ns, segment.end_ns)
          end
        end
        out
      end

      def instants
        @trace.events.reject(&:scheduler?).reject(&:recorder?).map do |event|
          { "ph" => "i", "pid" => @pid, "tid" => event.ruby_thread_id, "ts" => micros(event.timestamp_ns),
            "name" => event.type, "s" => "t", "args" => event.metadata.merge("source" => event.source) }
        end
      end

      def complete(pid, tid, name, start_ns, end_ns, args = {})
        { "ph" => "X", "pid" => pid, "tid" => tid, "name" => name,
          "ts" => micros(start_ns), "dur" => (end_ns - start_ns) / 1000.0, "args" => args.compact }
      end

      def meta(name, pid, tid, args)
        { "ph" => "M", "pid" => pid, "tid" => tid, "name" => name, "args" => args }.compact
      end

      def micros(timestamp_ns) = @trace.relative_ns(timestamp_ns) / 1000.0
    end
  end
end
