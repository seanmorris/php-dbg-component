<?php

/**
 * The landing page. The Markdown supplies wide bands; nothing is confined to
 * the reading measure, because the product itself is shown at working size.
 */

?><!DOCTYPE html>
<html lang="en" class="<?=escapeHtml(getConf('DEFAULT_THEME') ?: 'theme-dbg')?>">
<head>
<?php include resolveTemplateInclude('templates/head.php'); ?>
</head>
<body class="home">
<?php include resolveTemplateInclude('templates/masthead.php'); ?>

	<main id="content" class="wrap landing">
		$body$
	</main>

<?php include resolveTemplateInclude('templates/colophon.php'); ?>
</body>
</html>
