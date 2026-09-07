# frozen_string_literal: true

RSpec.describe "probes" do
  describe RuntimeVisualizer::Probes::Sleep do
    it "brackets Kernel#sleep with enter and exit events" do
      trace = record(probes: [:sleep]) { sleep 0.01 }
      enter = trace.events.find { |e| e.type == "sleep_enter" }
      exit = trace.events.find { |e| e.type == "sleep_exit" }
      expect(enter.metadata["requested_us"]).to eq(10_000)
      expect(enter.native_event).to eq("Kernel#sleep")
      expect(enter.source).to eq("probe")
      expect(exit.timestamp_ns - enter.timestamp_ns).to be >= 10_000_000
    end

    it "records a null duration for an open-ended sleep" do
      trace = record(probes: [:sleep]) do
        t = Thread.new { sleep }
        Thread.pass until t.status == "sleep"
        t.wakeup
        t.join
      end
      enter = trace.events.find { |e| e.type == "sleep_enter" }
      expect(enter.metadata["requested_us"]).to be_nil
    end

    it "keeps a sub-millisecond sleep distinguishable from an open-ended one" do
      trace = record(probes: [:sleep]) { sleep 0.0002 }
      expect(trace.events.find { |e| e.type == "sleep_enter" }.metadata["requested_us"]).to eq(200)
    end

    it "is muted inside Probes.silence on that thread only" do
      trace = record(probes: [:sleep]) do
        other = Thread.new { sleep 0.001 }
        RuntimeVisualizer::Probes.silence { sleep 0.001 }
        other.join
      end
      expect(trace.events.count { |e| e.type == "sleep_enter" }).to eq(1)
      expect(trace.events.find { |e| e.type == "sleep_enter" }.ruby_thread_id).not_to eq(1)
    end

    it "leaves Kernel#sleep's return value alone" do
      result = nil
      record(probes: [:sleep]) { result = sleep(0.001) }
      expect(result).to be_a(Integer)
    end

    it "is silent when not selected" do
      trace = record(probes: []) { sleep 0.001 }
      expect(trace.events.map(&:type)).not_to include("sleep_enter")
    end
  end

  describe RuntimeVisualizer::Probes::Mutex do
    it "sees lock, unlock and synchronize" do
      mutex = Mutex.new
      trace = record(probes: [:mutex]) do
        mutex.lock
        mutex.unlock
        mutex.synchronize { 1 }
      end
      types = trace.events.select(&:probe?).map(&:type)
      expect(types).to eq(%w[mutex_lock_wait mutex_acquired mutex_released mutex_lock_wait mutex_acquired mutex_released])
      ids = trace.events.select(&:probe?).map { |e| e.metadata["mutex_id"] }.uniq
      expect(ids).to eq([mutex.object_id & 0xFFFFFFFF])
    end

    it "records try_lock only when it succeeds" do
      mutex = Mutex.new
      trace = record(probes: [:mutex]) do
        mutex.lock
        Thread.new { mutex.try_lock }.join
        mutex.unlock
      end
      expect(trace.events.count { |e| e.type == "mutex_acquired" }).to eq(1)
    end

    it "keeps mutex semantics" do
      mutex = Mutex.new
      record(probes: [:mutex]) do
        expect(mutex.synchronize { :inside }).to eq(:inside)
        expect(mutex.locked?).to be(false)
        expect { mutex.unlock }.to raise_error(ThreadError)
      end
    end
  end
end
