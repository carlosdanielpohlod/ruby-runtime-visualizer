# Sleeping threads release the GVL. With the sleep probe on (the default),
# the SUSPENDED intervals that fall inside Kernel#sleep are labelled
# SLEEPING; a SUSPENDED for any other reason keeps its generic label.
#
#   runtime-visualizer trace examples/sleep.rb

sleeper = Thread.new do
  3.times do
    sleep 0.05
    10_000.times { |i| i * i }
  end
end

worker = Thread.new do
  value = 0
  2_000_000.times { value += 1 }
  value
end

[sleeper, worker].each(&:join)
