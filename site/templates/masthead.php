<?php

/**
 * The header and its links, the same on every page.
 */

$repository = (string) (getConf('DOCS_REPOSITORY') ?: '');
$version = (string) (getConf('DOCS_VERSION') ?: '');
$source = preg_replace('#^.*?/pages/#', '', (string) $pageFile) ?? '';
$links = [
	['Guide', '/guide/', 'guide/'],
	['Reference', '/reference/', 'reference/'],
];

?>	<a class="skip-link" href="#content">Skip to content</a>
	<header class="masthead">
		<div class="wrap masthead-inner">
			<a class="brand" href="<?=escapeHtml(resolveAssetUrl('/'))?>">
				<img src="<?=escapeHtml(resolveAssetUrl('/mark.svg'))?>" width="24" height="24" alt="">
				<span class="brand-name"><?=escapeHtml(getConf('PRODUCT_NAME'))?></span>
				<?php if($version !== ''): ?><span class="brand-version"><?=escapeHtml($version)?></span><?php endif; ?>
			</a>
			<nav class="masthead-links" aria-label="Site">
				<?php foreach($links as [$label, $href, $prefix]): ?>
				<a href="<?=escapeHtml(resolveAssetUrl($href))?>"<?=str_starts_with($source, $prefix) ? ' aria-current="true"' : ''?>><?=escapeHtml($label)?></a>
				<?php endforeach; ?>
				<?php if($repository !== ''): ?><a href="<?=escapeHtml($repository)?>">GitHub</a><?php endif; ?>
				<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch to dark theme" aria-pressed="false">
					<svg class="theme-icon theme-icon--moon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
					<svg class="theme-icon theme-icon--sun" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
				</button>
			</nav>
		</div>
	</header>
