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
  cp BUILT_SO, LIB_SO unless FileUtils.identical?(BUILT_SO, LIB_SO)
end

desc "Remove build products"
task :clean do
  rm_rf File.expand_path("tmp", __dir__)
  rm_f LIB_SO
end

RSpec::Core::RakeTask.new(:spec)
task spec: :compile

task default: :spec
