# Phoebe runtime contracts

- `status-v2.schema.json` describes the atomically replaced runtime projection,
  including the `queue` work-order lookahead.
- `events-v1.schema.json` describes one normalized Work Outcome journal record.
- `fixtures/` is the compatibility corpus for consumers and future versions.

Unknown additive fields are compatible. A different major in `schemaVersion`
is not compatible and must produce an explicit capability error.
