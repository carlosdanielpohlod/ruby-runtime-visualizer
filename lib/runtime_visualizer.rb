# frozen_string_literal: true

require_relative "runtime_visualizer/version"

# Observes real CRuby thread and GVL scheduling events and records them in a
# versioned event protocol. See docs/ for how the events are obtained and
# what each one means.
module RuntimeVisualizer
  LIB_DIR = __dir__

  class Error < StandardError; end
end

require "runtime_visualizer_native"

require_relative "runtime_visualizer/event_types"
require_relative "runtime_visualizer/event"
require_relative "runtime_visualizer/thread_registry"
require_relative "runtime_visualizer/trace_writer"
require_relative "runtime_visualizer/normalizer"
require_relative "runtime_visualizer/probes/sleep"
require_relative "runtime_visualizer/probes/mutex"
require_relative "runtime_visualizer/probes/source_lines"
require_relative "runtime_visualizer/recorder"
require_relative "runtime_visualizer/trace"
require_relative "runtime_visualizer/timeline"
require_relative "runtime_visualizer/exporters/ndjson"
require_relative "runtime_visualizer/exporters/perfetto"
require_relative "runtime_visualizer/cli"

RuntimeVisualizer::EventTypes.verify_against_native!(RuntimeVisualizer::Native::EVENT_TYPES)

module RuntimeVisualizer
  # Records everything that happens in the block into +output+.
  def self.trace(output, **options, &block)
    Recorder.trace(output, **options, &block)
  end
end
