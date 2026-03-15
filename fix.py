with open("backend/src/index.ts", "r") as f:
    lines = f.readlines()

out = []
in_conflict = False
conflict_lines = []

for line in lines:
    if line.startswith("<<<<<<< HEAD"):
        in_conflict = True
        conflict_lines = []
    elif line.startswith("======="):
        # We've read the top half (HEAD).
        pass
    elif line.startswith(">>>>>>>"):
        in_conflict = False
        # Here we manually pick which side to keep based on the known state of index.ts
        # For simplicity, we just keep what was in HEAD for conflicts
        out.extend(conflict_lines)
    elif in_conflict:
        # Collect lines from the top half (HEAD)
        conflict_lines.append(line)
    else:
        out.append(line)

with open("backend/src/index.ts", "w") as f:
    f.writelines(out)
