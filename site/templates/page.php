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
<?php include resolveTemplateInclude('templates/contents.php'); ?>
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
