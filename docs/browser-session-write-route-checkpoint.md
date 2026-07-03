# Browser Session Write Route Checkpoint

This checkpoint records the public write-route surface after the legacy product-specific browser write routes routes were removed.

## Active browser/session write routes

- `console.write.browser.session.open`
- `console.write.browser.session.input.draft`
- `console.write.browser.session.submit`
- `console.write.browser.session.target.cleanup`
- `console.write.browser.session.control.copy`
- `console.write.browser.session.control.activate`
- `console.write.browser.connector.refresh.execute`
- `console.write.browser.session.run.loop.daemon.start`
- `console.write.browser.session.run.loop.daemon.stop`
- `console.write.browser.session.run.loop.recover.step`
- `console.write.browser.session.run.loop.recover.prune.missing`

## Removed public legacy write-route pattern

- product-specific browser write routes

## Current cleanup intent

The next cleanup pass may remove dead implementation code that used to back the removed public legacy routes.
This checkpoint is intentionally small so the repository can be reset to this state if the deeper cleanup causes a regression.

## Safety contract

- Draft and submit remain separate tool contracts.
- Submit tools do not accept draft text.
