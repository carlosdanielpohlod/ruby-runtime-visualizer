# frozen_string_literal: true

RSpec.describe RuntimeVisualizer::Trace do
  let(:trace) { fixture("cpu_threads.rvtrace") }

  it "loads header, events, threads, stats and end" do
    expect(trace.schema_version).to eq(1)
    expect(trace.events.size).to eq(trace.stats["events_recorded"])
    expect(trace.threads.size).to eq(3)
    expect(trace.thread_label(1)).to eq("main")
    expect(trace.thread_label(2)).to eq("Thread #2")
    expect(trace.duration_ns).to be > 1_000_000_000
    expect(trace.complete?).to be(true)
  end

  it "keeps events in sequence order" do
    expect(trace.events.map(&:sequence)).to eq(trace.events.map(&:sequence).sort)
  end

  it "tolerates a file that ends early" do
    lines = File.readlines(File.join(TraceHelpers::FIXTURES, "cpu_threads.rvtrace"))
    truncated = described_class.parse(StringIO.new(lines.first(20).join))
    expect(truncated.complete?).to be(false)
    expect(truncated.events.size).to eq(19)
    expect(truncated.end_ns).to eq(truncated.events.last.timestamp_ns)
  end

  it "ignores records it does not know" do
    parsed = described_class.parse(StringIO.new(%({"record":"header","trace_start_ns":1}\n{"record":"future","x":1}\n)))
    expect(parsed.events).to be_empty
  end

  it "round-trips through the NDJSON exporter" do
    io = StringIO.new
    RuntimeVisualizer::Exporters::Ndjson.export(trace, io)
    again = described_class.parse(StringIO.new(io.string))
    expect(again.events).to eq(trace.events)
    expect(again.threads.transform_values(&:to_h)).to eq(trace.threads.transform_values(&:to_h))
    expect(again.header["trace_start_ns"]).to eq(trace.header["trace_start_ns"])
    expect(again.trace_end_ns).to eq(trace.trace_end_ns)
  end
end
