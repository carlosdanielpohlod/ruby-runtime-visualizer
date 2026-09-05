# frozen_string_literal: true

require "json"

module RuntimeVisualizer
  # Writes .rvtrace files: one JSON object per line. See docs/event-protocol.md.
  class TraceWriter
    def self.open(output)
      io = output.respond_to?(:write) ? output : File.open(output, "w")
      new(io, owns_io: !output.respond_to?(:write))
    end

    def initialize(io, owns_io: false)
      @io = io
      @owns_io = owns_io
    end

    def header(fields) = write("record" => "header", "format" => "rvtrace", "schema_version" => SCHEMA_VERSION, **fields)
    def event(event) = write(event.to_h)
    def thread(fields) = write(fields)
    def source_file(id:, path:, content:) = write("record" => "source_file", "id" => id, "path" => path, "content" => content)
    def stats(fields) = write("record" => "stats", **fields)
    def finish(trace_end_ns:) = write("record" => "end", "trace_end_ns" => trace_end_ns)

    def flush = @io.flush

    def close
      @io.flush
      @io.close if @owns_io
    end

    private

    def write(hash)
      @io.write("#{JSON.generate(hash)}\n")
    end
  end
end
