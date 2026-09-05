# frozen_string_literal: true

require "set"

module RuntimeVisualizer
  # Keeps what is known about each Ruby thread serial: its name, whether it
  # is the main thread, and which native threads it was seen on.
  #
  # Names come from Thread objects, and Thread objects can only be matched
  # to serials while they are alive. The recorder snapshots Thread.list at
  # start, at every drain and at stop; a thread that is born and dies
  # between two snapshots is recorded with a null name.
  class ThreadRegistry
    Entry = Struct.new(:ruby_thread_id, :name, :main, :first_native_thread_id, :native_thread_ids) do
      def to_h
        { "record" => "thread", "ruby_thread_id" => ruby_thread_id, "name" => name, "main" => main,
          "first_native_thread_id" => first_native_thread_id,
          "native_thread_ids" => native_thread_ids.to_a.sort }
      end
    end

    attr_reader :entries

    def initialize
      @entries = {}
      @serial_by_native_thread_id = {}
    end

    def entry(serial)
      @entries[serial] ||= Entry.new(serial, nil, false, nil, Set.new)
    end

    # Learns native thread placement from an event. Only events whose
    # callback is known to have run on the thread's own native thread count;
    # a READY fired by a waker says nothing about where the thread lives.
    def observe(event)
      return if event.ruby_thread_id.zero?
      return unless event.metadata["native_thread_role"] == "self"

      e = entry(event.ruby_thread_id)
      e.first_native_thread_id ||= event.native_thread_id
      e.native_thread_ids << event.native_thread_id
      @serial_by_native_thread_id[event.native_thread_id] = event.ruby_thread_id
    end

    def snapshot(threads = Thread.list)
      threads.each do |thread|
        serial = serial_for(thread)
        next if serial.nil? || serial.zero?

        e = entry(serial)
        e.main = true if thread == Thread.main
        e.name = thread == Thread.main ? (thread.name || "main") : thread.name
      end
    end

    def to_records = @entries.values.sort_by(&:ruby_thread_id).map(&:to_h)

    private

    # 3.3+: the serial is stored on the Thread itself. 3.2: identity lives in
    # the native thread's TLS and the scheduler is 1:1, so the latest serial
    # seen on the thread's native thread is the thread.
    def serial_for(thread)
      if Native::THREAD_IDENTITY_ATTACHED_TO_THREAD
        Native.thread_serial(thread)
      elsif thread == Thread.current
        Native.current_thread_serial
      else
        @serial_by_native_thread_id[thread.native_thread_id]
      end
    end
  end
end
