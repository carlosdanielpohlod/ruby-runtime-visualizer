# frozen_string_literal: true

RSpec.describe RuntimeVisualizer::Native do
  describe "hook lifecycle" do
    it "installs and removes the hooks" do
      expect(described_class.active?).to be(false)
      described_class.start(1024, 0)
      expect(described_class.active?).to be(true)
      described_class.stop
      expect(described_class.active?).to be(false)
    end

    it "refuses to start twice" do
      described_class.start(1024, 0)
      expect { described_class.start(1024, 0) }.to raise_error(RuntimeError, /already running/)
    end

    it "refuses to stop when idle" do
      expect { described_class.stop }.to raise_error(RuntimeError, /not running/)
    end

    it "rejects tiny buffers" do
      expect { described_class.start(4, 0) }.to raise_error(ArgumentError)
    end

    it "keeps working across several sessions" do
      first = record { Thread.new { spin }.join }
      second = record { Thread.new { spin }.join }
      expect(first.events).not_to be_empty
      expect(second.events).not_to be_empty
      expect(second.events.first.sequence).to eq(1)
      expect(second.threads.keys.max).to be > first.threads.keys.max
    end
  end

  describe "thread events" do
    let(:trace) { record { Thread.new { spin }.join } }
    let(:worker_id) { (trace.thread_ids - [1]).min }

    it "reports the five scheduler transitions of a new thread in order" do
      types = scheduler_types_for(trace, worker_id)
      expect(types.first).to eq("thread_started")
      expect(types.last).to eq("thread_exited")
      expect(types).to include("wants_gvl", "gvl_acquired", "gvl_released")
      expect(types.index("wants_gvl")).to be < types.index("gvl_acquired")
      expect(types.index("gvl_acquired")).to be < types.rindex("gvl_released")
    end

    it "carries the CRuby constant with every scheduler event" do
      trace.events.select(&:scheduler?).each do |event|
        expect(event.native_event).to start_with("RUBY_INTERNAL_THREAD_EVENT_")
        expect(event.source).to eq("cruby_internal_thread_event")
        expect(event.precision).to eq("observed")
      end
    end

    it "assigns strictly increasing sequence numbers without gaps" do
      sequences = trace.events.map(&:sequence)
      expect(sequences).to eq((1..sequences.size).to_a)
    end

    it "timestamps every event inside the session with a monotonic clock" do
      started = trace.header["trace_start_ns"]
      ended = trace.trace_end_ns
      trace.events.each do |event|
        expect(event.timestamp_ns).to be_between(started, ended)
      end
      trace.thread_ids.each do |id|
        timestamps = trace.events_for(id).map(&:timestamp_ns)
        expect(timestamps).to eq(timestamps.sort)
      end
    end

    it "keeps Ruby thread identity separate from the native thread id" do
      event = trace.events_for(worker_id).find { |e| e.type == "gvl_acquired" }
      expect(event.ruby_thread_id).to eq(worker_id)
      expect(event.native_thread_id).to be > 0
      expect(event.native_thread_id).not_to eq(worker_id)
    end

    it "brackets the session with recorder events on the starting thread" do
      expect(trace.events.first.type).to eq("tracing_started")
      expect(trace.events.last.type).to eq("tracing_stopped")
      expect(trace.events.first.ruby_thread_id).to eq(1)
    end

    it "marks which native thread ran the callback" do
      started = trace.events_for(worker_id).find { |e| e.type == "thread_started" }
      resumed = trace.events_for(worker_id).find { |e| e.type == "gvl_acquired" }
      expect(resumed.metadata["native_thread_role"]).to eq("self")
      if described_class::THREAD_IDENTITY_ATTACHED_TO_THREAD
        expect(started.metadata["native_thread_role"]).to eq("creator")
        expect(started.native_thread_id).to eq(trace.events.first.native_thread_id)
      else
        expect(started.metadata["native_thread_role"]).to eq("self")
      end
    end
  end

  describe "buffer overflow" do
    it "reports dropped events instead of losing them silently" do
      trace = record(buffer_capacity: 16, gc_events: false, probes: []) do
        4.times.map { Thread.new { spin(50_000) } }.each(&:join)
      end
      dropped = trace.events.find { |e| e.type == "events_dropped" }
      expect(dropped).not_to be_nil
      expect(dropped.metadata["count"]).to be > 0
      expect(dropped.source).to eq("recorder")
      expect(trace.stats["events_dropped"]).to eq(dropped.metadata["count"])
      expect(trace.stats["buffer_high_water_mark"]).to eq(16)
    end

    it "loses nothing when the buffer is large enough" do
      trace = record(buffer_capacity: 65_536) { 8.times.map { Thread.new { spin } }.each(&:join) }
      expect(trace.stats["events_dropped"]).to eq(0)
      expect(trace.events.map(&:type)).not_to include("events_dropped")
    end
  end

  describe "GC events" do
    it "records enter and exit on the thread that collected" do
      trace = record(probes: []) { GC.start }
      types = types_for(trace, 1)
      expect(types).to include("gc_enter", "gc_exit")
      expect(types.index("gc_enter")).to be < types.index("gc_exit")
      expect(trace.events.find { |e| e.type == "gc_enter" }.native_event).to eq("RUBY_INTERNAL_EVENT_GC_ENTER")
    end

    it "can be switched off" do
      trace = record(gc_events: false, probes: []) { GC.start }
      expect(trace.events.map(&:type)).not_to include("gc_enter")
      expect(trace.channels).not_to include("cruby_gc_tracepoint")
    end
  end

  describe ".mark" do
    it "records probe events for the calling thread" do
      described_class.start(1024, 0)
      expect(described_class.mark(described_class::EVENT_TYPES[:SLEEP_ENTER], 5, 0)).to be(true)
      described_class.stop
      raw = described_class.drain(100).each_slice(described_class::FIELDS_PER_EVENT).to_a
      sleep_enter = raw.find { |r| r[4] == described_class::EVENT_TYPES[:SLEEP_ENTER] }
      expect(sleep_enter[2]).to eq(described_class.current_thread_serial)
      expect(sleep_enter[5]).to eq(5)
    end

    it "refuses to forge scheduler events" do
      described_class.start(1024, 0)
      expect { described_class.mark(described_class::EVENT_TYPES[:THREAD_RESUMED], 0, 0) }.to raise_error(ArgumentError)
    end

    it "is a no-op while idle" do
      expect(described_class.mark(described_class::EVENT_TYPES[:SLEEP_ENTER], 0, 0)).to be(false)
    end
  end

  describe "thread identity" do
    it "gives the current thread a stable serial" do
      expect(described_class.current_thread_serial).to eq(described_class.current_thread_serial)
      expect(described_class.current_thread_serial).to be > 0
    end

    it "answers for other threads only when identity is attached to the Thread object" do
      other = Thread.new { sleep }
      serial = described_class.thread_serial(other)
      if described_class::THREAD_IDENTITY_ATTACHED_TO_THREAD
        expect(serial).to be > 0
        expect(described_class.thread_serial(other)).to eq(serial)
      else
        expect(serial).to eq(0)
      end
      other.kill.join
    end

    it "reports the same native thread id as Thread#native_thread_id" do
      expect(described_class.current_native_thread_id).to eq(Thread.current.native_thread_id)
    end
  end

  describe "stress" do
    it "survives a hundred short-lived threads" do
      trace = record(buffer_capacity: 1 << 18) do
        100.times.map { Thread.new { 10_000.times { 1 + 1 } } }.each(&:join)
      end
      started = trace.events.count { |e| e.type == "thread_started" }
      exited = trace.events.count { |e| e.type == "thread_exited" }
      expect(started).to eq(100)
      expect(exited).to eq(100)
      expect(trace.stats["threads_unidentified"]).to eq(0)
      expect(RuntimeVisualizer::Timeline.new(trace).violations).to be_empty
    end

    it "survives threads that block, sleep and contend on a mutex at once" do
      mutex = Mutex.new
      trace = record do
        threads = 8.times.map do |i|
          Thread.new do
            mutex.synchronize { sleep 0.001 }
            i.even? ? spin(20_000) : sleep(0.002)
          end
        end
        threads.each(&:join)
      end
      expect(trace.events.count { |e| e.type == "thread_exited" }).to eq(8)
      expect(RuntimeVisualizer::Timeline.new(trace).violations).to be_empty
    end
  end

  describe "fork" do
    it "keeps the parent's trace intact and starts a fresh file in the child" do
      Dir.mktmpdir do |dir|
        parent_path = File.join(dir, "parent.rvtrace")
        child_pid = nil
        RuntimeVisualizer.trace(parent_path, probes: []) do
          child_pid = fork do
            Thread.new { spin(10_000) }.join
            exit(0)
          end
          Process.wait(child_pid)
          Thread.new { spin(10_000) }.join
        end

        parent = RuntimeVisualizer::Trace.load(parent_path)
        expect(parent.complete?).to be(true)
        expect(parent.header["process_id"]).to eq(Process.pid)

        child_path = File.join(dir, "parent.pid#{child_pid}.rvtrace")
        expect(File).to exist(child_path)
        child = RuntimeVisualizer::Trace.load(child_path)
        expect(child.header["process_id"]).to eq(child_pid)
        expect(child.complete?).to be(true)
        expect(child.events.first.type).to eq("tracing_started")
        expect(child.events.map(&:type)).to include("thread_started", "thread_exited")
      end
    end
  end
end
