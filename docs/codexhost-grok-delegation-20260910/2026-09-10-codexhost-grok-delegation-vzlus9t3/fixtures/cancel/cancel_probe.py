from pathlib import Path
import os,json,time
p=Path(__file__).resolve().parent
(p/"started.json").write_text(json.dumps({"pid":os.getpid(),"cwd":os.getcwd(),"token":"cancel-vzlus9t3"}))
print("CANCEL_PROBE_STARTED",flush=True)
time.sleep(40)
(p/"late.txt").write_text("CANCEL_PROBE_FINISHED")
print("CANCEL_PROBE_FINISHED",flush=True)
