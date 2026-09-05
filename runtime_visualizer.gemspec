# frozen_string_literal: true

require_relative "lib/runtime_visualizer/version"

Gem::Specification.new do |spec|
  spec.name = "runtime_visualizer"
  spec.version = RuntimeVisualizer::VERSION
  spec.authors = ["Carlos Pohlod"]
  spec.email = ["carlospohlod@gmail.com"]

  spec.summary = "Records real CRuby thread and GVL scheduling events for interactive visualization"
  spec.description = <<~TEXT
    A native recorder for CRuby's internal thread instrumentation API, a versioned
    event protocol with explicit provenance, and exporters for a web timeline and
    Perfetto.
  TEXT
  spec.homepage = "https://github.com/carlosdanielpohlod/ruby-runtime-visualizer"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.2"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir["lib/**/*.rb", "ext/**/*.{c,h,rb}", "exe/*", "docs/*.md", "examples/*.rb", "LICENSE", "README.md"]
  spec.bindir = "exe"
  spec.executables = ["runtime-visualizer"]
  spec.require_paths = ["lib"]
  spec.extensions = ["ext/runtime_visualizer_native/extconf.rb"]
end
