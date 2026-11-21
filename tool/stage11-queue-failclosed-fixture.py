#!/usr/bin/python3
"""Isolated release queue fail-closed fixture, with no protected-root writes."""
import ast
import json
import os
import pathlib
import tempfile
import time

source=pathlib.Path(__file__).resolve().parents[1]/"ops/ubuntu/deployment/gates.py"
tree=ast.parse(source.read_text())
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef)
          and node.name in ("_queue_read_record","queue_snapshot")]
assert len(selected)==2
scope={"os":os,"json":json,"time":time,"pathlib":pathlib}
exec(compile(ast.Module(body=selected,type_ignores=[]),str(source),"exec"),scope)
scan=scope["queue_snapshot"]


def refuse(eng,source,tag):
    try:
        scan(eng,source)
        raise AssertionError(tag+" accepted")
    except RuntimeError as error:
        assert str(error).startswith(("QUEUE_","MANAGED_SERVER_","task queue")), (tag,str(error))


with tempfile.TemporaryDirectory(prefix="stage11-release-queue-") as temp:
    root=pathlib.Path(temp)
    engine=root/"engine"
    work=root/"work"
    engine.mkdir()
    work.mkdir()
    first=engine/"task.json"
    first.write_text(json.dumps({"status":"succeeded","pid":1234}))
    base=work/"project"/".console-mcp"/"command-run"/"run1"
    base.mkdir(parents=True)
    state=base/"state.json"
    state.write_text(json.dumps({"status":"failed","pid":1234}))
    report=scan(engine,work)
    assert report["checked"]==2 and not report["active"] and not report["staleDeadProcessRecords"]
    first.write_text("{bad")
    refuse(engine,work,"malformed JSON")
    first.write_text(json.dumps({"pid":1234}))
    refuse(engine,work,"missing status")
    first.write_text(json.dumps({"status":"unknown_future_state"}))
    assert len(scan(engine,work)["active"])==1
    first.write_text(json.dumps({"status":"running","pid":999999999}))
    report=scan(engine,work)
    assert len(report["staleDeadProcessRecords"])==1
    first.write_text(json.dumps({"status":"queued","pid":"bad"}))
    refuse(engine,work,"invalid pid")
    first.write_text(json.dumps({"status":"succeeded"}))
    state.unlink()
    state.symlink_to(first)
    refuse(engine,work,"symlink to terminal record")
    state.unlink()
    state.write_bytes(b"x"*1048577)
    refuse(engine,work,"large record")
    state.unlink()
    state.write_text(json.dumps({"status":"stopped"}))
    first.unlink()
    first.symlink_to(state)
    refuse(engine,work,"engine symlink")
    first.unlink()
    assert scan(engine,work)["checked"]==1
    php=work/"project"/".console-mcp"/"local-php-server-8000.json"
    php.write_text(json.dumps({"pid":55555,"tool":"local-php-server"}))
    assert len(scan(engine,work)["managedServerRecords"])==1
    php.unlink()
    mobile=work/"project"/".console-mcp"/"mobile-edge-server.json"
    mobile.write_text(json.dumps({"pid":55556,"packageName":"mobile-edge"}))
    assert len(scan(engine,work)["managedServerRecords"])==1
    mobile.unlink()
    gallery=work/"project"/"var"/".visual-gallery"
    gallery.mkdir(parents=True)
    server=gallery/"server.json"
    server.write_text(json.dumps({"pid":55557,"tool":"visual-gallery-server"}))
    assert len(scan(engine,work)["managedServerRecords"])==1
    server.unlink()
    server.symlink_to(state)
    refuse(engine,work,"managed gallery symlink")
    server.unlink()
    php.write_text("{corrupted")
    refuse(engine,work,"managed server corrupt state")
    php.unlink()
    engine.rmdir()
    refuse(engine,work,"missing engine task root")
    print("STAGE11_QUEUE_MALFORMED_STALE_SYMLINK_FAILCLOSED_PASS")
