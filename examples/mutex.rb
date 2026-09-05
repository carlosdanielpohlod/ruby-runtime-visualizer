# Two threads contend for one mutex. The mutex probe records lock/unlock
# boundaries, so the GVL release that happens while a thread waits for
# the mutex can be labelled WAITING_MUTEX (derived from the probe, not
# reported by the scheduler).
#
#   runtime-visualizer trace examples/mutex.rb

mutex = Mutex.new

threads = 2.times.map do |i|
  Thread.new do
    mutex.synchronize do
      puts i
      sleep 0.2
    end
  end
end

threads.each(&:join)
