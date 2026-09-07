# frozen_string_literal: true

require "rspec/core/rake_task"

EXT_DIR = File.expand_path("ext/runtime_visualizer_native", __dir__)
BUILD_DIR = File.expand_path("tmp/#{RUBY_VERSION}", __dir__)
BUILT_SO = "#{BUILD_DIR}/runtime_visualizer_native.so"
LIB_SO = File.expand_path("lib/runtime_visualizer_native.so", __dir__)
SOURCES = FileList["#{EXT_DIR}/*.{c,h}", "#{EXT_DIR}/extconf.rb"]

directory BUILD_DIR

# One build directory per Ruby version, so switching versions only costs a copy.
file BUILT_SO => [*SOURCES, BUILD_DIR] do
  Dir.chdir(BUILD_DIR) do
    ruby "#{EXT_DIR}/extconf.rb"
    sh "make"
  end
end

desc "Build the native extension for the current Ruby and place it in lib/"
task compile: BUILT_SO do
  cp BUILT_SO, LIB_SO unless File.exist?(LIB_SO) && FileUtils.identical?(BUILT_SO, LIB_SO)
end

desc "Remove build products"
task :clean do
  rm_rf File.expand_path("tmp", __dir__)
  rm_f LIB_SO
end

RSpec::Core::RakeTask.new(:spec)
task spec: :compile

task default: :spec

namespace :web do
  WEB_FIXTURES = FileList["web/src/__fixtures__/*.rvtrace"]

  desc "Regenerate web/src/__fixtures__/expected/*.json from the Ruby reference model"
  task expected: :compile do
    require "json"
    $LOAD_PATH.unshift(File.expand_path("lib", __dir__))
    require "runtime_visualizer"

    WEB_FIXTURES.each do |path|
      trace = RuntimeVisualizer::Trace.load(path)
      timeline = RuntimeVisualizer::Timeline.new(trace)
      expected = {
        "threads" => timeline.ruby_thread_ids.to_h do |id|
          [id.to_s, timeline.thread_segments[id].map do |s|
            { "state" => s.state, "start_ns" => s.start_ns, "end_ns" => s.end_ns,
              "precision" => s.precision, "native_event" => s.native_event, "sequence" => s.sequence }
          end]
        end,
        "gvl" => timeline.gvl_segments.map do |g|
          { "owner" => g.owner, "start_ns" => g.start_ns, "end_ns" => g.end_ns, "precision" => g.precision }
        end,
        "violations" => timeline.violations.map do |v|
          { "sequence" => v.sequence, "rubyThreadId" => v.ruby_thread_id, "message" => v.message }
        end
      }
      target = "web/src/__fixtures__/expected/#{File.basename(path, '.rvtrace')}.json"
      File.write(target, "#{JSON.pretty_generate(expected)}\n")
      puts "wrote #{target}"
    end
  end
end
