<?php

/**
 * The landing page. The hero, from the page's `hero` field, spans the page:
 * the debugger is shown at working size, with what to try under it. The body
 * follows in the documentation pages' frame, beside the same contents.
 */

?><!DOCTYPE html>
<html lang="en" class="<?=escapeHtml(getConf('DEFAULT_THEME') ?: 'theme-dbg')?>">
<head>
<?php include resolveTemplateInclude('templates/head.php'); ?>
</head>
<body class="home">
<?php include resolveTemplateInclude('templates/masthead.php'); ?>

	<main id="content" class="landing">
		<div class="wrap hero">
			$hero$
		</div>
		<div class="wrap frame">
<?php include resolveTemplateInclude('templates/contents.php'); ?>
			<div class="sheet">
				<article class="prose">
					$body$
				</article>
			</div>
		</div>
	</main>

<?php include resolveTemplateInclude('templates/colophon.php'); ?>
</body>
</html>
