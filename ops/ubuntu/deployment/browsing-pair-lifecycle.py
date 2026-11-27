"""Compose the existing pair transaction, publication and runtime witnesses.

No live entrypoint. The host adapter must independently prove ingress exclusion
for both processes, including startup, before any service mutation.
"""
import copy
import re

CONSOLE='console-mcp.service'
BROWSING='browser-mcp-worker.service'

def need(ok,reason):
    if not ok:raise RuntimeError(reason)

def checked(value,reason):
    need(value is True,reason)
    return True

class Lifecycle:
    def __init__(self,binding,host):
        self.binding=copy.deepcopy(binding)
        self.host=host
        self.generation=binding['checkpoint'].rsplit('-',1)[-1]
        need(re.fullmatch('[a-f0-9]{32}',self.generation),'PAIR_LIFECYCLE_GENERATION')

    def same(self,b):
        need(b==self.binding,'PAIR_LIFECYCLE_BINDING_DRIFT')

    def preflight(self,b):
        self.same(b)
        # No implicit legacy grace period, no reliance on queue() alone.
        # Host must attest real support from both exact runtime generations.
        h=self.host
        checked(h.verify_generation(b),'PAIR_LIFECYCLE_GENERATION_UNVERIFIED')
        checked(h.verify_preservation(b),'PAIR_LIFECYCLE_PRESERVATION_DENIED')
        checked(h.verify_incumbent_ingress(b),'PAIR_LIFECYCLE_LEGACY_INGRESS_UNSUPPORTED')
        checked(h.verify_worker_startup_exclusion(b),'PAIR_LIFECYCLE_WORKER_STARTUP_UNPROVEN')
        checked(h.verify_external_quiescence_contract(b),'PAIR_LIFECYCLE_EXTERNAL_INGRESS_UNPROVEN')
        checked(h.verify_rollback_checkpoint(b),'PAIR_LIFECYCLE_CHECKPOINT_UNVERIFIED')
        return True

    def step(self,direction,step,b):
        self.same(b)
        need(direction in ('forward','rollback'),'PAIR_LIFECYCLE_DIRECTION')
        h=self.host;g=self.generation
        # All host methods are explicit contracts, not generic shell strings.
        # Recovery can run after policy expiry; immutable journal identity and
        # checkpoint must still match before any restoration action.
        checked(h.verify_recovery_identity(b),'PAIR_LIFECYCLE_RECOVERY_IDENTITY')
        if step=='quiesce':
            checked(h.close_ingress(g),'PAIR_LIFECYCLE_GATE_CLOSE')
            checked(h.quiesce_console(g,b),'PAIR_LIFECYCLE_CONSOLE_DRAIN')
            checked(h.quiesce_external(g,b),'PAIR_LIFECYCLE_EXTERNAL_DRAIN')
        elif direction=='forward' and step=='install_pair':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.publish_pair(b,g,True),'PAIR_LIFECYCLE_PUBLICATION')
            checked(h.reload_units(),'PAIR_LIFECYCLE_RELOAD')
        elif direction=='forward' and step=='start_worker':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.verify_worker_startup_exclusion(b),'PAIR_LIFECYCLE_WORKER_STARTUP_UNPROVEN')
            checked(h.start_drained_worker(b,g),'PAIR_LIFECYCLE_WORKER_START')
        elif direction=='forward' and step=='restart_console':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.switch_console(b,g,True),'PAIR_LIFECYCLE_CONSOLE_SWITCH')
        elif direction=='forward' and step=='verify_pair':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.verify_paired_runtime(b,g),'PAIR_LIFECYCLE_PAIR_UNVERIFIED')
        elif direction=='rollback' and step=='drain_worker':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.drain_worker_if_present(b,g),'PAIR_LIFECYCLE_WORKER_DRAIN')
        elif direction=='rollback' and step=='stop_worker':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.stop_exact_worker(b,g),'PAIR_LIFECYCLE_WORKER_STOP')
        elif direction=='rollback' and step=='restore_config':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.publish_pair(b,g,False),'PAIR_LIFECYCLE_RESTORE')
            checked(h.restore_checkpoint(b,g),'PAIR_LIFECYCLE_CHECKPOINT_RESTORE')
            checked(h.reload_units(),'PAIR_LIFECYCLE_RELOAD')
        elif direction=='rollback' and step=='restart_legacy':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.switch_console(b,g,False),'PAIR_LIFECYCLE_CONSOLE_RESTORE')
        elif direction=='rollback' and step=='verify_legacy':
            checked(h.assert_excluded(g,b),'PAIR_LIFECYCLE_EXCLUSION_LOST')
            checked(h.verify_rollback_runtime(b,g),'PAIR_LIFECYCLE_ROLLBACK_UNVERIFIED')
        elif step=='resume_ingress':
            # The journal records its durable decision before this step.
            # Never open worker or Console ingress until the selected runtime
            # has been reverified; reopening is idempotent after a crash.
            checked(h.verify_decided_runtime(b,g,direction),'PAIR_LIFECYCLE_DECIDED_RUNTIME_DRIFT')
            checked(h.resume_selected_ingress(b,g,direction),'PAIR_LIFECYCLE_RESUME')
        else:raise RuntimeError('PAIR_LIFECYCLE_STEP_DENIED')
        return True
