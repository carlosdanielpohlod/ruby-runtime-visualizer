# Small enough to trace line by line. Run with --lines to see where each
# thread is in the source while it holds the GVL; expect the schedule to
# differ from an untraced run, because TracePoint makes every line cost
# more. Compare with cpu_threads.rb, which is far too hot for this channel.
#
#   runtime-visualizer trace --lines examples/source_lines.rb

def busy(rounds)
  total = 0
  rounds.times do |i|
    total += i
  end
  total
end

workers = 2.times.map do |n|
  Thread.new do
    busy(20_000)
    sleep 0.02
    busy(20_000)
  end
end

workers.each(&:join)
