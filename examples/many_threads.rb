# A hundred short-lived threads. Useful for watching the ready queue and for
# checking the recorder under a burst of scheduler events.
#
#   runtime-visualizer trace examples/many_threads.rb

100.times.map do
  Thread.new do
    10_000.times { 1 + 1 }
  end
end.each(&:join)
