# frozen_string_literal: true

module RuntimeVisualizer
  module Exporters
    # Re-serialises a loaded trace in the canonical format. Useful for
    # normalising a truncated file (crash before the tail) into a complete
    # one, or for filtering.
    module Ndjson
      def self.export(trace, io, events: trace.events)
        writer = TraceWriter.new(io)
        writer.header(trace.header.reject { |k, _| %w[record format schema_version].include?(k) })
        events.each { |event| writer.event(event) }
        trace.threads.values.sort_by(&:ruby_thread_id).each do |t|
          writer.thread("record" => "thread", "ruby_thread_id" => t.ruby_thread_id, "name" => t.name, "main" => t.main,
                        "first_native_thread_id" => t.first_native_thread_id, "native_thread_ids" => t.native_thread_ids)
        end
        trace.source_files.each_value { |f| writer.source_file(id: f.id, path: f.path, content: f.content) }
        writer.stats(trace.stats.reject { |k, _| k == "record" }) unless trace.stats.empty?
        writer.finish(trace_end_ns: trace.end_ns)
        writer.flush
      end
    end
  end
end
