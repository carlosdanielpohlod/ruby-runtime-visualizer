# frozen_string_literal: true

require "json"

module RuntimeVisualizer
  # An .rvtrace file loaded into memory.
  class Trace
    ThreadInfo = Struct.new(:ruby_thread_id, :name, :main, :first_native_thread_id, :native_thread_ids, keyword_init: true) do
      def label = name || (main ? "main" : "Thread ##{ruby_thread_id}")
    end

    SourceFile = Struct.new(:id, :path, :content, keyword_init: true)

    attr_reader :header, :events, :threads, :source_files, :stats, :trace_end_ns, :path

    def self.load(path)
      File.open(path) { |io| parse(io, path: path) }
    end

    def self.parse(io, path: nil)
      trace = new(path: path)
      io.each_line do |line|
        line = line.strip
        next if line.empty?

        trace.add_record(JSON.parse(line))
      end
      trace.finalize
    end

    def initialize(path: nil)
      @path = path
      @header = {}
      @events = []
      @threads = {}
      @source_files = {}
      @stats = {}
      @trace_end_ns = nil
    end

    def add_record(record)
      case record["record"]
      when "header" then @header = record
      when "event" then @events << Event.from_h(record)
      when "thread" then add_thread(record)
      when "source_file" then @source_files[record["id"]] = SourceFile.new(id: record["id"], path: record["path"], content: record["content"])
      when "stats" then @stats = record
      when "end" then @trace_end_ns = record["trace_end_ns"]
      end
    end

    def finalize
      @events.sort_by!(&:sequence)
      @events.each do |event|
        next if event.ruby_thread_id.zero?

        @threads[event.ruby_thread_id] ||= ThreadInfo.new(ruby_thread_id: event.ruby_thread_id, main: false, native_thread_ids: [])
      end
      self
    end

    def schema_version = header["schema_version"]
    def trace_start_ns = header["trace_start_ns"] || events.first&.timestamp_ns || 0
    def end_ns = trace_end_ns || events.last&.timestamp_ns || trace_start_ns
    def duration_ns = end_ns - trace_start_ns
    def relative_ns(timestamp_ns) = timestamp_ns - trace_start_ns
    def channels = header.fetch("channels", [])
    def thread(id) = threads[id]
    def thread_label(id) = threads[id]&.label || "Thread ##{id}"
    def complete? = !@trace_end_ns.nil?

    def thread_ids = threads.keys.sort

    def events_for(ruby_thread_id) = events.select { |e| e.ruby_thread_id == ruby_thread_id }

    private

    def add_thread(record)
      @threads[record["ruby_thread_id"]] = ThreadInfo.new(
        ruby_thread_id: record["ruby_thread_id"], name: record["name"], main: record["main"],
        first_native_thread_id: record["first_native_thread_id"], native_thread_ids: record["native_thread_ids"] || []
      )
    end
  end
end
