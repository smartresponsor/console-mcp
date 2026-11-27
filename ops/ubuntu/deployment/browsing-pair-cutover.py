"""First-pair transaction state machine, deliberately not a production adapter.

Uses the existing deploy transaction.json writer/lock. The backend is an
independently admitted implementation of quiescence, service transitions,
and identity/readiness gates. No alternate broker or executable entrypoint.
"""
import copy
import hashlib
import json
import re

FORWARD=('quiesce','install_pair','start_worker','restart_console','verify_pair','resume_ingress')
ROLLBACK=('quiesce','drain_worker','stop_worker','restore_config','restart_legacy','verify_legacy','resume_ingress')
SHA=re.compile('[0-9a-f]{40}')
CHECKPOINT=re.compile('[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}')

def require(ok,msg):
    if not ok:raise RuntimeError(msg)

def binding(reg):
    pair=reg.get('browsingPair')
    plan=reg.get('browsingRuntimePlan')
    c=reg.get('candidate')
    require(isinstance(c,str) and SHA.fullmatch(c) and reg.get('sourceSHA')==c,'PAIR_TX_SOURCE')
    require(isinstance(reg.get('rollback'),str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,100}',reg['rollback']) and reg['rollback']!=c,'PAIR_TX_ROLLBACK')
    require(isinstance(reg.get('checkpoint'),str) and CHECKPOINT.fullmatch(reg['checkpoint']),'PAIR_TX_CHECKPOINT')
    require(type(pair) is dict and pair.get('consoleSHA')==c and pair.get('activationEligible') is False,'PAIR_TX_PAIR')
    require(type(plan) is dict and plan.get('pair')==pair and plan.get('activationEligible') is False and plan.get('baseline',{}).get('consolePid')==reg.get('oldPid'),'PAIR_TX_PLAN')
    return dict(candidate=c,rollback=reg['rollback'],sourceSHA=c,checkpoint=reg['checkpoint'],
                pair=copy.deepcopy(pair),plan=copy.deepcopy(plan))

def pin(b):
    return hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def initial(reg):
    b=binding(reg)
    return dict(schemaVersion=1,kind='browsing-pair-first-rollout',phase='pending',
                candidate=b['candidate'],rollback=b['rollback'],sourceSHA=b['sourceSHA'],
                binding=b,bindingSha256=pin(b),direction='forward',completed=[],intent=None,decision=None)

def validate(state,reg):
    require(type(state) is dict and state.get('kind')=='browsing-pair-first-rollout' and state.get('schemaVersion')==1,'PAIR_TX_SCHEMA')
    b=binding(reg)
    require(state.get('binding')==b and state.get('bindingSha256')==pin(b)
            and all(state.get(k)==b[k] for k in ('candidate','rollback','sourceSHA')),'PAIR_TX_BINDING_DRIFT')
    direction=state.get('direction')
    require(direction in ('forward','rollback'),'PAIR_TX_DIRECTION')
    steps=FORWARD if direction=='forward' else ROLLBACK
    done=state.get('completed')
    require(type(done) is list and len(done)<=len(steps) and done==list(steps[:len(done)]),'PAIR_TX_SEQUENCE')
    intent=state.get('intent')
    require(intent is None or len(done)<len(steps) and intent==steps[len(done)],'PAIR_TX_INTENT')
    phase=state.get('phase')
    decision=state.get('decision')
    require(decision is None or (decision==('committed' if direction=='forward' else 'rolled_back') and len(done)>=len(steps)-1),'PAIR_TX_DECISION')
    require((intent!='resume_ingress' and 'resume_ingress' not in done) or decision is not None,'PAIR_TX_RESUME_WITHOUT_DECISION')
    require(phase in ('pending','committed','rolled_back'),'PAIR_TX_PHASE')
    if phase!='pending':
        require(intent is None and done==list(steps) and decision==phase and ((phase=='committed')==(direction=='forward')),'PAIR_TX_TERMINAL')
    return steps

def durable(write,state):
    # Caller uses the existing fsync+atomic-replace transaction writer.
    write(copy.deepcopy(state))

def execute(state,reg,write,backend):
    steps=validate(state,reg)
    require(state['phase']=='pending','PAIR_TX_NOT_PENDING')
    for step in steps[len(state['completed']):]:
        state['intent']=step
        if step=='resume_ingress':
            # Persist the irreversible generation decision BEFORE exposing
            # ingress. A crash after exposure must not roll back accepted work.
            state['decision']='committed' if state['direction']=='forward' else 'rolled_back'
        durable(write,state) # record intent and decision before ANY side effect
        # Backend must be idempotent on recovery and independently verify
        # its own postcondition. An exception leaves the intent durable.
        require(backend.step(state['direction'],step,copy.deepcopy(state['binding'])) is True,'PAIR_TX_STEP_UNVERIFIED:'+step)
        state['completed'].append(step)
        state['intent']=None
        durable(write,state)
    state['phase']='committed' if state['direction']=='forward' else 'rolled_back'
    durable(write,state)
    return copy.deepcopy(state)

def recover(state,reg,write,backend,explicit=False):
    validate(state,reg)
    if state['phase']=='rolled_back':return copy.deepcopy(state)
    if state['phase']=='committed' and not explicit:return copy.deepcopy(state)
    if state['phase']=='pending' and state['decision'] is not None:
        # Finish reopening/finalization, never undo already accepted requests.
        # Explicit rollback requires a separate call after finalization.
        return execute(state,reg,write,backend)
    if state['direction']=='forward':
        # Before the decision, never resume a partial forward switch.
        prior=dict(completed=copy.deepcopy(state['completed']),intent=state['intent'],phase=state['phase'],decision=state['decision'])
        state=copy.deepcopy(state)
        state.update(phase='pending',direction='rollback',completed=[],intent=None,decision=None,forwardEvidence=prior)
        durable(write,state)
    return execute(state,reg,write,backend)

def apply(reg,write,backend):
    state=initial(reg)
    # Preflight MUST be read-only and must prove the exact generation and
    # availability of an actual ingress exclusion mechanism. A queue snapshot
    # alone is insufficient. This is not a policy grant.
    require(backend.preflight(copy.deepcopy(state['binding'])) is True,'PAIR_TX_PREFLIGHT_DENIED')
    durable(write,state)
    try:return execute(state,reg,write,backend)
    except Exception:
        # If persistence itself fails, do not infer which mutation happened
        # from process memory. The outer controller must recover from the
        # durable journal rather than automatically proceeding.
        raise
