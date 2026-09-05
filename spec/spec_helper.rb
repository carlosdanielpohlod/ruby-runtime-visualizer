# frozen_string_literal: true

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))

require "runtime_visualizer"
require "stringio"
require "tempfile"

module TraceHelpers
  FIXTURES = File.expand_path("fixtures", __dir__)

  def fixture(name) = RuntimeVisualizer::Trace.load(File.join(FIXTURES, name))

  # Records the block into memory and returns the parsed Trace.
  def record(**options, &block)
    io = StringIO.new
    RuntimeVisualizer::Recorder.trace(io, **options, &block)
    RuntimeVisualizer::Trace.parse(StringIO.new(io.string))
  end

  def spin(iterations = 200_000)
    value = 0
    iterations.times { value += 1 }
    value
  end

  def types_for(trace, ruby_thread_id) = trace.events_for(ruby_thread_id).map(&:type)

  def scheduler_types_for(trace, ruby_thread_id) = trace.events_for(ruby_thread_id).select(&:scheduler?).map(&:type)

  def thread_id_of(trace, thread)
    if RuntimeVisualizer::Native::THREAD_IDENTITY_ATTACHED_TO_THREAD
      RuntimeVisualizer::Native.thread_serial(thread)
    else
      trace.threads.values.find { |t| t.native_thread_ids.include?(thread.native_thread_id) }&.ruby_thread_id
    end
  end
end

RSpec.configure do |config|
  config.include TraceHelpers
  config.disable_monkey_patching!
  config.order = :random
  config.example_status_persistence_file_path = "tmp/.rspec_status"

  config.after do
    RuntimeVisualizer::Native.stop if RuntimeVisualizer::Native.active?
    RuntimeVisualizer::Recorder.instance_variable_set(:@current, nil)
  end
end
