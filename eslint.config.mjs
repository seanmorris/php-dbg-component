import smNoSaccadeStyle from 'sm-no-saccade-style';

export default [
	{
		ignores: [
			'.cache/**'
			, 'docs/assets/**'
			, 'node_modules/**'
			, 'playwright-report/**'
			, 'runtime-bundle/**'
			, 'test-results/**'
		]
	}
	, ...smNoSaccadeStyle.configs.recommended
];
