-- Expectations on table models (DLT-style): a boolean predicate over the model's output and
-- an action. warn records violations, drop removes violating rows before publishing, fail
-- stops the run without publishing. Results are kept per run.
ALTER TABLE models ADD COLUMN expectations TEXT NOT NULL DEFAULT '[]';
CREATE TABLE model_expectation_results (
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 model_id TEXT NOT NULL,
 name TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('warn','drop','fail')),
 failed_rows INTEGER NOT NULL,
 total_rows INTEGER NOT NULL,
 PRIMARY KEY(run_id, name)
);
CREATE INDEX model_expectation_results_model ON model_expectation_results(model_id, run_id);
