# frozen_string_literal: true

if RUBY_ENGINE != "ruby"
  abort "runtime_visualizer relies on CRuby's internal thread instrumentation API " \
        "and cannot be built on #{RUBY_ENGINE}."
end

if Gem.win_platform?
  abort "runtime_visualizer is not supported on Windows: CRuby's thread " \
        "instrumentation hooks are a no-op there."
end

if RUBY_VERSION < "3.2"
  abort "runtime_visualizer needs Ruby 3.2 or newer (rb_internal_thread_add_event_hook)."
end

require "mkmf"

have_func("gettid", "unistd.h")
# Present from Ruby 3.3: event_data carries the Thread and per-thread slots exist.
have_func("rb_internal_thread_specific_get", "ruby/thread.h")

$CFLAGS << " -std=gnu11 -Wall -Wextra -Wno-unused-parameter"
$CFLAGS << " -Werror" if ENV["RV_WERROR"]

create_header
create_makefile("runtime_visualizer_native")
