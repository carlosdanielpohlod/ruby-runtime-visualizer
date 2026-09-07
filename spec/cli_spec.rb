# frozen_string_literal: true

RSpec.describe RuntimeVisualizer::CLI do
  let(:out) { StringIO.new }
  let(:err) { StringIO.new }

  def run(*args) = described_class.run(args, out: out, err: err)

  it "prints usage without a command" do
    expect(run).to eq(0)
    expect(out.string).to include("Usage: runtime-visualizer")
  end

  it "fails on an unknown command" do
    expect(run("bogus")).to eq(1)
    expect(err.string).to include("unknown command")
  end

  it "traces a script into a file and inspects it" do
    Dir.mktmpdir do |dir|
      script = File.join(dir, "demo.rb")
      File.write(script, "Thread.new { 10_000.times { 1 + 1 } }.join\nFile.write(File.join(__dir__, 'argv'), ARGV.inspect)\n")
      output = File.join(dir, "demo.rvtrace")

      expect(run("trace", "-o", output, script, "a", "b")).to eq(0)
      expect(err.string).to include("trace written to")
      trace = RuntimeVisualizer::Trace.load(output)
      expect(trace.header["script"]).to eq(script)
      expect(trace.events.map(&:type)).to include("thread_started", "gvl_acquired", "thread_exited")
      expect(File.read(File.join(dir, "argv"))).to eq('["a", "b"]')

      expect(run("inspect", output)).to eq(0)
      expect(out.string).to include("RUBY_INTERNAL_THREAD_EVENT_RESUMED", "threads:", "main")

      out.truncate(0)
      expect(run("stats", output)).to eq(0)
      expect(out.string).to include("events_recorded", "tracing_duration")
    end
  end

  it "keeps the trace and the exit status when the script calls exit" do
    Dir.mktmpdir do |dir|
      script = File.join(dir, "exits.rb")
      File.write(script, "exit 3\n")
      output = File.join(dir, "exits.rvtrace")
      expect(run("trace", "-o", output, script)).to eq(3)
      expect(RuntimeVisualizer::Trace.load(output).complete?).to be(true)
    end
  end

  it "exports to Perfetto" do
    Dir.mktmpdir do |dir|
      target = File.join(dir, "out.json")
      expect(run("export", "--perfetto", File.join(TraceHelpers::FIXTURES, "sleep.rvtrace"), "-o", target)).to eq(0)
      expect(JSON.parse(File.read(target))).to be_an(Array)
    end
  end

  it "requires a format for export" do
    expect(run("export", File.join(TraceHelpers::FIXTURES, "sleep.rvtrace"))).to eq(1)
    expect(err.string).to include("--perfetto")
  end

  it "complains about a missing trace file" do
    expect(run("stats", "/nonexistent.rvtrace")).to eq(1)
  end
end
