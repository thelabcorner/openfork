import random
import sqlite3
import statistics
import time


ROWS = 300_000
PROJECTS = 24
DIRS_PER_PROJECT = 8
QUERIES = 250


def build() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA temp_store=MEMORY")
    db.execute(
        """
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          directory TEXT NOT NULL,
          parent_id TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          title TEXT NOT NULL
        )
        """
    )
    db.execute("CREATE INDEX session_project_idx ON session(project_id)")
    db.execute("CREATE INDEX session_parent_idx ON session(parent_id)")
    batch = []
    for i in range(ROWS):
        p = i % PROJECTS
        d = (i // PROJECTS) % DIRS_PER_PROJECT
        root = (i % 5) != 0
        batch.append(
            (
                f"ses_{i:08d}",
                f"p{p}",
                f"/project/{p}/dir/{d}",
                None if root else f"ses_{max(0, i - 1):08d}",
                1_690_000_000_000 + (i // 3),
                1_700_000_000_000 + i,
                f"Session {i}",
            )
        )
        if len(batch) == 10_000:
            db.executemany("INSERT INTO session VALUES (?,?,?,?,?,?,?)", batch)
            batch.clear()
    if batch:
        db.executemany("INSERT INTO session VALUES (?,?,?,?,?,?,?)", batch)
    db.commit()
    return db


PROJECT_SQL = """
SELECT * FROM session
WHERE project_id = ? AND directory = ? AND parent_id IS NULL
ORDER BY time_updated DESC
LIMIT 25
"""

DIRECTORY_SQL = """
SELECT * FROM session
WHERE directory = ? AND parent_id IS NULL
ORDER BY time_created DESC, id DESC
LIMIT 25
"""


def measure_project(db: sqlite3.Connection, label: str):
    samples = []
    rng = random.Random(7)
    for _ in range(QUERIES):
        p = rng.randrange(PROJECTS)
        d = rng.randrange(DIRS_PER_PROJECT)
        t0 = time.perf_counter_ns()
        db.execute(PROJECT_SQL, (f"p{p}", f"/project/{p}/dir/{d}")).fetchall()
        samples.append((time.perf_counter_ns() - t0) / 1e6)
    plan = db.execute("EXPLAIN QUERY PLAN " + PROJECT_SQL, ("p1", "/project/1/dir/1")).fetchall()
    print(
        label,
        {
            "median_ms": round(statistics.median(samples), 4),
            "p95_ms": round(sorted(samples)[int(len(samples) * 0.95) - 1], 4),
            "max_ms": round(max(samples), 4),
            "plan": plan,
        },
    )


def measure_directory(db: sqlite3.Connection, label: str):
    samples = []
    rng = random.Random(11)
    for _ in range(QUERIES):
        p = rng.randrange(PROJECTS)
        d = rng.randrange(DIRS_PER_PROJECT)
        t0 = time.perf_counter_ns()
        db.execute(DIRECTORY_SQL, (f"/project/{p}/dir/{d}",)).fetchall()
        samples.append((time.perf_counter_ns() - t0) / 1e6)
    plan = db.execute("EXPLAIN QUERY PLAN " + DIRECTORY_SQL, ("/project/1/dir/1",)).fetchall()
    print(
        label,
        {
            "median_ms": round(statistics.median(samples), 4),
            "p95_ms": round(sorted(samples)[int(len(samples) * 0.95) - 1], 4),
            "max_ms": round(max(samples), 4),
            "plan": plan,
        },
    )


db = build()
measure_project(db, "project_baseline")
measure_directory(db, "directory_baseline")

started = time.perf_counter()
db.execute(
    "CREATE INDEX session_project_directory_parent_updated_idx "
    "ON session(project_id, directory, parent_id, time_updated)"
)
db.commit()
print("full_composite_create_ms", round((time.perf_counter() - started) * 1000, 3))
measure_project(db, "project_full_composite")
db.execute("DROP INDEX session_project_directory_parent_updated_idx")

started = time.perf_counter()
db.execute(
    "CREATE INDEX session_project_directory_root_updated_idx "
    "ON session(project_id, directory, time_updated) WHERE parent_id IS NULL"
)
db.commit()
print("partial_root_create_ms", round((time.perf_counter() - started) * 1000, 3))
measure_project(db, "project_partial_root")

started = time.perf_counter()
db.execute(
    "CREATE INDEX session_directory_root_created_id_idx "
    "ON session(directory, time_created, id) WHERE parent_id IS NULL"
)
db.commit()
print("directory_partial_root_create_ms", round((time.perf_counter() - started) * 1000, 3))
measure_directory(db, "directory_partial_root")
