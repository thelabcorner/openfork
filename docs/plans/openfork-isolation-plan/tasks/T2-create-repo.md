# T2 — Create repo and push

**Lane:** git-ops + human  
**After:** T1  
**Unlocks:** T3 T4 T5 T6

## Human does the push. Agent may prepare commands.

## Do

1. `git remote -v` — today `origin` is anomalyco. **Treat any push to current origin as forbidden.**
2. `git remote rename origin upstream`
3. Create empty private repo (human):

   ```powershell
   gh repo create thelabcorner/openfork --private --description "Branch-fork of OpenCode Desktop"
   git remote add origin https://github.com/thelabcorner/openfork.git
   git branch -M main
   git push -u origin main
   ```

4. `git remote -v` must show origin = thelabcorner/openfork, upstream = anomalyco/opencode.
5. `gh repo view thelabcorner/openfork --json name,isPrivate,defaultBranchRef`

## Do not

`gh repo create --source=.` if the tree might still be dirty. Fork-button. `--mirror`. `filter-repo`. Public unless T0 said public.

## Done when

`main` is on GitHub, private, history includes `a747d51764` and the T1 checkpoint. Remotes are correct.
