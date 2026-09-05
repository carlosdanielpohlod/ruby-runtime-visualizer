# Measures what each instrumentation channel costs, on this machine, for a
# thread-heavy workload. Numbers go into docs/tracing-overhead.md.
#
#   ruby -Ilib benchmarks/overhead.rb
#
# Every configuration runs the same workload ROUNDS times after a warm-up,
# and the median wall time is reported next to the untraced baseline.

require "runtime_visualizer"
require "tmpdir"

ROUNDS = Integer(ENV.fetch("ROUNDS", 5))

def workload
  threads = 4.times.map do
    Thread.new do
      value = 0
      200_000.times { value += 1 }
      sleep 0.005
      200_000.times { value += 1 }
    end
  end
  threads.each(&:join)
end

def hot_loop_workload
  threads = 2.times.map do
    Thread.new do
      value = 0
      50_000.times { value += 1 }
    end
  end
  threads.each(&:join)
end

def median_ms(rounds)
  workload_times = rounds.times.map do
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    yield
    (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000
  end
  workload_times.sort[rounds / 2]
end

CONFIGURATIONS = {
  "untraced" => nil,
  "thread hooks only" => { gc_events: false, probes: [] },
  "thread hooks + GC" => { gc_events: true, probes: [] },
  "thread hooks + GC + probes (default)" => { gc_events: true, probes: %i[sleep mutex] },
  "+ source lines (--lines)" => { gc_events: true, probes: %i[sleep mutex], source_lines: true, drain_interval: 0.05 }
}.freeze

def run(name, options, workload_name)
  workload_method = method(workload_name)
  workload_method.call # warm-up

  Dir.mktmpdir do |dir|
    events = nil
    ms = median_ms(ROUNDS) do
      if options
        RuntimeVisualizer.trace(File.join(dir, "bench.rvtrace"), **options) { workload_method.call }
        events = RuntimeVisualizer::Native.stats[:events_recorded]
      else
        workload_method.call
      end
    end
    [name, ms, events]
  end
end

puts "Ruby #{RUBY_VERSION} (#{RUBY_PLATFORM}), RUBY_MN_THREADS=#{ENV.fetch('RUBY_MN_THREADS', 'unset')}, #{ROUNDS} rounds, median wall time"
puts

%i[workload hot_loop_workload].each do |workload_name|
  puts "#{workload_name}:"
  baseline = nil
  CONFIGURATIONS.each do |name, options|
    label, ms, events = run(name, options, workload_name)
    baseline ||= ms
    printf("  %-40s %9.2f ms  %6.2fx  %s\n", label, ms, ms / baseline, events ? "#{events} events" : "")
  end
  puts
end
