<?php

declare(strict_types=1);

return (new PhpCsFixer\Config())
    ->setFinder(PhpCsFixer\Finder::create()->in(__DIR__.'/tool')->name('*.php'))
    ->setRules(['@PSR12' => true]);

