<?php

/**
 * The contents column, the same on the landing page and the documentation
 * pages. On a phone the contents fold behind its button. The script after the
 * button shows it before the list is drawn, so the list never flashes open;
 * without scripts, the button stays hidden and the whole list shows, as it
 * does on a wider screen.
 */

?>		<aside class="contents">
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
