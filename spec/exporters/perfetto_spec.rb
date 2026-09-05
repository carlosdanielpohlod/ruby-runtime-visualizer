# frozen_string_literal: true

require "json"

RSpec.describe RuntimeVisualizer::Exporters::Perfetto do
  let(:trace) { fixture("mutex.rvtrace") }
  let(:entries) do
    io = StringIO.new
    described_class.new(trace).export(io)
    JSON.parse(io.string)
  end

  it "produces Chrome Trace Event JSON" do
    expect(entries).to all(include("ph", "pid"))
    expect(entries.map { |e| e["ph"] }.uniq).to contain_exactly("M", "X", "i")
  end

  it "names the threads and the GVL lane" do
    names = entries.select { |e| e["name"] == "thread_name" }.map { |e| e.dig("args", "name") }
    expect(names).to include("main", "GVL owner", "Thread #2", "Thread #3")
  end

  it "keeps every duration non-negative and relative to the trace start" do
    complete = entries.select { |e| e["ph"] == "X" }
    expect(complete.map { |e| e["dur"] }).to all(be >= 0)
    expect(complete.map { |e| e["ts"] }.min).to eq(0.0)
  end

  it "carries the derived states and their precision" do
    waiting = entries.find { |e| e["name"] == "WAITING_MUTEX" }
    expect(waiting.dig("args", "precision")).to eq("derived")
  end

  it "adds a native threads view under a separate pid" do
    pids = entries.map { |e| e["pid"] }.uniq
    expect(pids.size).to eq(2)
    native = entries.select { |e| e["pid"] == pids.max && e["ph"] == "X" }
    expect(native.map { |e| e["tid"] }.uniq).to all(be > 1000)
  end
end
