# frozen_string_literal: true

RSpec.describe RuntimeVisualizer::Recorder do
  it "writes a complete file: header, events, threads, stats, end" do
    trace = record { Thread.new { spin }.join }
    expect(trace.header).to include("format" => "rvtrace", "schema_version" => 1, "clock" => "CLOCK_MONOTONIC",
                                    "ruby_version" => RUBY_VERSION, "process_id" => Process.pid)
    expect(trace.header["trace_start_ns"]).to eq(trace.events.first.timestamp_ns)
    expect(trace.threads[1]).to have_attributes(name: "main", main: true)
    expect(trace.stats["events_recorded"]).to eq(trace.events.size)
    expect(trace.complete?).to be(true)
    expect(trace.trace_end_ns).to be >= trace.events.last.timestamp_ns
  end

  it "lists the channels that were on" do
    expect(record { nil }.channels).to include("cruby_internal_thread_event", "recorder", "cruby_gc_tracepoint", "probe:sleep", "probe:mutex")
    expect(record(probes: [], gc_events: false) { nil }.channels).to eq(%w[cruby_internal_thread_event recorder])
  end

  it "names threads that are alive when the session ends" do
    sleeper = Thread.new { sleep }
    sleeper.name = "worker-a"
    trace = record { Thread.pass until sleeper.status == "sleep" }
    sleeper.kill.join
    named = trace.threads.values.find { |t| t.name == "worker-a" }
    expect(named).not_to be_nil
    expect(named.ruby_thread_id).to be > 1
  end

  it "cannot name a thread that died between snapshots" do
    trace = record do
      t = Thread.new { sleep 0.01 }
      t.name = "short-lived"
      t.join
    end
    expect(trace.threads.values.map(&:name)).not_to include("short-lived")
  end

  it "records which native threads each Ruby thread ran on" do
    trace = record { Thread.new { spin }.join }
    worker = trace.threads[(trace.thread_ids - [1]).min]
    expect(worker.native_thread_ids).not_to be_empty
    expect(worker.first_native_thread_id).to eq(worker.native_thread_ids.first)
  end

  it "refuses two sessions at once" do
    described_class.trace(StringIO.new) do
      expect { described_class.new(StringIO.new).start }.to raise_error(ArgumentError, /already active/)
    end
  end

  it "labels the ractor when only the main ractor exists" do
    trace = record { nil }
    expect(trace.events.map(&:ractor_id).uniq).to eq([1])
  end

  context "with a background drain thread" do
    it "drains while the program runs and announces its own thread" do
      trace = record(drain_interval: 0.01, probes: []) { 3.times { Thread.new { spin(300_000) }.join } }
      expect(trace.stats["drain_count"]).to be > 1
      expect(trace.header["recorder_thread_id"]).to be_a(Integer)
      expect(trace.threads[trace.header["recorder_thread_id"]].name).to eq("runtime_visualizer.drain")
      expect(trace.events.map(&:sequence)).to eq((1..trace.events.size).to_a)
    end
  end

  context "with source line tracing" do
    it "records lines with file and line number and embeds the files" do
      trace = record(source_lines: true, drain_interval: 0.01) { Thread.new { spin(500) }.join }
      lines = trace.events.select { |e| e.type == "source_line" }
      expect(lines).not_to be_empty
      here = trace.source_files.values.find { |f| f.path == __FILE__ }
      expect(here.content).to include("records lines with file and line number")
      expect(lines.map { |e| e.metadata["path_id"] }).to include(here.id)
      expect(lines.first.source).to eq("tracepoint")
      expect(trace.channels).to include("tracepoint:line")
    end

    it "keeps the recorder's own code out of the trace" do
      trace = record(source_lines: true, drain_interval: 0.01) { Thread.new { spin(500) }.join }
      paths = trace.source_files.values.map(&:path)
      expect(paths.grep(/runtime_visualizer/)).to be_empty
      drain_id = trace.header["recorder_thread_id"]
      expect(trace.events_for(drain_id).map(&:type)).not_to include("source_line")
    end
  end
end
