# frozen_string_literal: true

RSpec.describe RuntimeVisualizer::Timeline do
  Timeline = RuntimeVisualizer::Timeline

  def synthetic(events, threads: {})
    trace = RuntimeVisualizer::Trace.new
    trace.add_record("record" => "header", "trace_start_ns" => 0)
    events.each_with_index do |(thread, type, ts), index|
      definition = RuntimeVisualizer::EventTypes::BY_TYPE.fetch(type)
      trace.add_record("record" => "event", "sequence" => index + 1, "timestamp_ns" => ts, "ruby_thread_id" => thread,
                       "native_thread_id" => 100 + thread, "ractor_id" => 1, "type" => type,
                       "native_event" => definition.native_event, "source" => definition.source, "precision" => "observed",
                       "metadata" => {})
    end
    threads.each { |id, name| trace.add_record("record" => "thread", "ruby_thread_id" => id, "name" => name, "main" => id == 1) }
    trace.add_record("record" => "end", "trace_end_ns" => events.last[2] + 10)
    trace.finalize
  end

  def states(timeline, id) = timeline.thread_segments[id].map { |s| [s.state, s.start_ns, s.end_ns, s.precision] }

  describe "state transitions" do
    it "follows the documented life cycle of a thread" do
      tl = described_class.new(synthetic([
        [1, "tracing_started", 0],
        [2, "thread_started", 10], [2, "wants_gvl", 20], [1, "gvl_released", 30], [2, "gvl_acquired", 40],
        [2, "gvl_released", 50], [2, "thread_exited", 60]
      ]))
      expect(states(tl, 2)).to eq([
        ["STARTED", 10, 20, "observed"], ["WANTS_GVL", 20, 40, "observed"], ["RUNNING", 40, 50, "observed"],
        ["SUSPENDED", 50, 60, "observed"], ["EXITED", 60, 70, "observed"]
      ])
      expect(tl.violations).to be_empty
    end

    it "treats a repeated SUSPENDED as one segment" do
      tl = described_class.new(synthetic([
        [1, "tracing_started", 0], [1, "gvl_released", 10], [1, "gvl_released", 11], [1, "wants_gvl", 20], [1, "gvl_acquired", 21]
      ]))
      expect(states(tl, 1).map(&:first)).to eq(%w[RUNNING SUSPENDED WANTS_GVL RUNNING])
    end

    it "closes a running thread when another one acquires the lock (3.2 preemption)" do
      tl = described_class.new(synthetic([
        [1, "tracing_started", 0], [1, "gvl_released", 5],
        [2, "gvl_acquired", 10], [3, "gvl_acquired", 20], [2, "wants_gvl", 25], [3, "gvl_released", 30], [2, "gvl_acquired", 31]
      ]))
      expect(states(tl, 2)).to eq([
        ["UNKNOWN", 0, 10, "inferred"], ["RUNNING", 10, 20, "observed"], ["PREEMPTED", 20, 25, "derived"],
        ["WANTS_GVL", 25, 31, "observed"], ["RUNNING", 31, 41, "observed"]
      ])
      expect(tl.gvl_segments.map { |s| [s.owner, s.start_ns, s.end_ns] }).to eq([
        [1, 0, 5], [nil, 5, 10], [2, 10, 20], [3, 20, 30], [nil, 30, 31], [2, 31, 41]
      ])
    end

    it "infers the state of a thread that was alive before tracing" do
      tl = described_class.new(synthetic([[1, "tracing_started", 0], [2, "gvl_released", 10], [3, "wants_gvl", 12]]))
      expect(states(tl, 2).first).to eq(["RUNNING", 0, 10, "inferred"])
      expect(states(tl, 3).first).to eq(["SUSPENDED", 0, 12, "inferred"])
    end

    it "reports a double acquisition instead of hiding it" do
      tl = described_class.new(synthetic([[1, "tracing_started", 0], [1, "gvl_acquired", 5]]))
      expect(tl.violations.map(&:message)).to eq(["gvl_acquired while already the owner"])
    end
  end

  describe "derived reasons" do
    it "labels a SUSPENDED enclosed by the sleep probe as SLEEPING" do
      tl = described_class.new(synthetic([
        [1, "tracing_started", 0], [1, "sleep_enter", 10], [1, "gvl_released", 11], [1, "wants_gvl", 30],
        [1, "gvl_acquired", 31], [1, "sleep_exit", 32], [1, "gvl_released", 40]
      ]))
      expect(states(tl, 1)).to include(["SLEEPING", 11, 30, "derived"], ["SUSPENDED", 40, 50, "observed"])
    end

    it "labels a SUSPENDED enclosed by the mutex probe as WAITING_MUTEX" do
      tl = described_class.new(synthetic([
        [1, "tracing_started", 0], [1, "mutex_lock_wait", 10], [1, "gvl_released", 11], [1, "wants_gvl", 30],
        [1, "gvl_acquired", 31], [1, "mutex_acquired", 32]
      ]))
      expect(states(tl, 1)).to include(["WAITING_MUTEX", 11, 30, "derived"])
    end
  end

  describe "invariants on real traces" do
    %w[cpu_threads.rvtrace sleep.rvtrace mutex.rvtrace cpu_threads_ruby32.rvtrace sleep_ruby32.rvtrace].each do |name|
      context name do
        let(:trace) { fixture(name) }
        let(:timeline) { described_class.new(trace) }

        it "never has two threads RUNNING at the same instant" do
          running = timeline.thread_segments.values.flatten.select { |s| s.state == Timeline::RUNNING }.sort_by(&:start_ns)
          running.each_cons(2) do |a, b|
            expect(b.start_ns).to be >= a.end_ns, "#{a.inspect} overlaps #{b.inspect}"
          end
        end

        it "covers the whole trace with GVL segments, no gaps and no overlaps" do
          segments = timeline.gvl_segments
          expect(segments.first.start_ns).to eq(trace.trace_start_ns)
          expect(segments.last.end_ns).to eq(trace.end_ns)
          segments.each_cons(2) { |a, b| expect(b.start_ns).to eq(a.end_ns) }
        end

        it "agrees with the RUNNING segments about who owns the GVL" do
          timeline.gvl_segments.reject(&:idle?).each do |gvl|
            expect(timeline.state_at(gvl.owner, gvl.start_ns)).to eq(Timeline::RUNNING)
          end
        end

        it "has no model violations" do
          expect(timeline.violations).to be_empty
        end
      end
    end

    it "sees the sleeps in the sleep example" do
      sleeping = described_class.new(fixture("sleep.rvtrace")).thread_segments.values.flatten.select { |s| s.state == Timeline::SLEEPING }
      expect(sleeping.size).to eq(3)
      sleeping.each { |s| expect(s.duration_ns).to be_between(45_000_000, 80_000_000) }
    end

    it "sees the mutex wait in the mutex example" do
      waiting = described_class.new(fixture("mutex.rvtrace")).thread_segments.values.flatten.select { |s| s.state == Timeline::WAITING_MUTEX }
      expect(waiting.size).to eq(1)
      expect(waiting.first.duration_ns).to be > 150_000_000
    end

    it "sees timeslice preemptions on Ruby 3.2" do
      preempted = described_class.new(fixture("cpu_threads_ruby32.rvtrace")).thread_segments.values.flatten.select { |s| s.state == Timeline::PREEMPTED }
      expect(preempted).not_to be_empty
      expect(preempted.map(&:precision).uniq).to eq(["derived"])
    end
  end
end
