# Two CPU-bound threads with a sleep in the middle. The classic picture of
# the GVL: only one thread runs Ruby code at a time, and CRuby hands the
# lock over every 100 ms.
#
#   runtime-visualizer trace examples/cpu_threads.rb

def cpu_work
  value = 0

  5_000_000.times do
    value += 1
  end

  value
end

threads = 2.times.map do |i|
  Thread.new do
    puts "Thread #{i} started"

    cpu_work

    sleep 0.2

    cpu_work

    puts "Thread #{i} finished"
  end
end

threads.each(&:join)
