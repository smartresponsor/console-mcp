# Browser Session Write Route Checkpoint

This checkpoint records the public write-route surface after the legacy product-specific browser write routes routes were removed.

## Active browser/session write routes

- `write.browser.session.open`
- `write.browser.session.input.draft`
- `write.browser.session.submit`
- `write.browser.session.target.cleanup`
- `write.browser.session.control.copy`
- `write.browser.session.control.activate`
- `write.browser.connector.refresh.execute`
- `write.browser.session.run.loop.daemon.start`
- `write.browser.session.run.loop.daemon.stop`
- `write.browser.session.run.loop.recover.step`
- `write.browser.session.run.loop.recover.prune.missing`

## Removed public legacy write-route pattern

- product-specific browser write routes

## Current cleanup intent

The next cleanup pass may remove dead implementation code that used to back the removed public legacy routes.
This checkpoint is intentionally small so the repository can be reset to this state if the deeper cleanup causes a regression.

## Safety contract

- Draft and submit remain separate tool contracts.
- Submit tools do not accept draft text.
