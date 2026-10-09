# Repository workflow

For every code change, follow this delivery sequence:

1. Modify the code in this local checkout first. Do not edit the production copy directly.
2. Run the relevant local tests and validation, including `npm test`, `npm run typecheck`, and `npm run build` when applicable. Resolve failures before delivery.
3. Review the final diff, then commit the tested change and push it to the remote repository.
4. Only after the commit is pushed, deploy with the documented repository deployment workflow so the running `dice-detector-ai` script is updated.
5. Verify the deployed service status and inspect its recent logs. Report any validation or deployment step that could not be completed.

Never deploy uncommitted or unpushed code.
