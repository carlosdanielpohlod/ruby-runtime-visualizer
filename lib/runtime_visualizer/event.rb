# frozen_string_literal: true

module RuntimeVisualizer
  # How much a fact can be trusted. See docs/event-protocol.md "Precision".
  module Precision
    OBSERVED = "observed"
    DERIVED = "derived"
    INFERRED = "inferred"
  end

  # One normalised event, exactly as it appears in an .rvtrace file.
  Event = Data.define(
    :sequence, :timestamp_ns, :ruby_thread_id, :native_thread_id, :ractor_id,
    :type, :native_event, :source, :precision, :metadata
  ) do
    def self.from_h(hash)
      new(
        sequence: hash.fetch("sequence"),
        timestamp_ns: hash.fetch("timestamp_ns"),
        ruby_thread_id: hash.fetch("ruby_thread_id"),
        native_thread_id: hash["native_thread_id"],
        ractor_id: hash["ractor_id"],
        type: hash.fetch("type"),
        native_event: hash["native_event"],
        source: hash.fetch("source"),
        precision: hash.fetch("precision", Precision::OBSERVED),
        metadata: hash.fetch("metadata", {})
      )
    end

    def definition = EventTypes.definition(type)
    def scheduler? = definition.scheduler?
    def gc? = definition.gc?
    def probe? = definition.probe?
    def recorder? = definition.recorder?

    def to_h
      h = { "record" => "event", "sequence" => sequence, "timestamp_ns" => timestamp_ns,
            "ruby_thread_id" => ruby_thread_id, "native_thread_id" => native_thread_id,
            "ractor_id" => ractor_id, "type" => type }
      h["native_event"] = native_event if native_event
      h["source"] = source
      h["precision"] = precision
      h["metadata"] = metadata unless metadata.empty?
      h
    end
  end
end
