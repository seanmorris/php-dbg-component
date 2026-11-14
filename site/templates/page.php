<?php

/**
 * A documentation page: contents on the left, the article in a readable
 * measure, and the page's outline on the right.
 */

$leftBarShow = $frontmatter['leftBarShow'] ?? true;
$repository = (string) (getConf('DOCS_REPOSITORY') ?: '');
$source = preg_replace('#^.*?/pages/#', '', (string) $pageFile) ?? '';

?><!DOCTYPE html>
<html lang="en" class="<?=escapeHtml(getConf('DEFAULT_THEME') ?: 'theme-dbg')?>">
<head>
<?php include resolveTemplateInclude('templates/head.php'); ?>
</head>
<body class="docs">
<?php include resolveTemplateInclude('templates/masthead.php'); ?>

	<div class="wrap frame">
		<?php if($leftBarShow): ?>
		<aside class="contents">
			<?php
			/*
			 * On a phone the contents fold behind this button. The script after it shows it before
			 * the list is drawn, so the list never flashes open; without scripts, the button stays
			 * hidden and the whole list shows, as it does on a wider screen.
			 */
			?>
			<button type="button" class="contents-toggle" aria-expanded="false" aria-controls="contents-nav" hidden>
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
				Contents
			</button>
			<script>
				{
					const toggle = document.currentScript.previousElementSibling;

					toggle.hidden = false;

					toggle.addEventListener('click', () => {
						const open = toggle.getAttribute('aria-expanded') === 'true';

						toggle.setAttribute('aria-expanded', String(!open));
					});
				}
			</script>
			<nav id="contents-nav" class="contents-nav" aria-label="Contents"><?php renderMenuRegion('sidebar'); ?></nav>
		</aside>
		<?php endif; ?>
		<main id="content" class="sheet">
			<article class="prose">
				<?php renderBreadcrumbs(); ?>
				$body$
				<?php if($repository !== ''): ?>
				<footer class="article-foot">
					<a href="<?=escapeHtml(rtrim($repository, '/') . '/edit/main/site/pages/' . $source)?>">Edit this page</a>
				</footer>
				<?php endif; ?>
			</article>
		</main>
		$if(toc)$
		<aside class="outline">
			<nav aria-label="On this page">
				<p class="outline-label">On this page</p>
				${toc}
			</nav>
		</aside>
		$endif$
	</div>

<?php include resolveTemplateInclude('templates/colophon.php'); ?>
</body>
</html>
