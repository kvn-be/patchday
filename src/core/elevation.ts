export const WORKER_TASK = 'Patchday Worker';
export const WORKER_FLAG = '--run-worker';

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A task without triggers: it only runs when Patchday starts it, with the rights granted once at setup.
export function workerTaskXml(userId: string, program: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Installs updates for Patchday without repeated admin prompts.</Description></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT6H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${escapeXml(program)}</Command><Arguments>${WORKER_FLAG}</Arguments></Exec>
  </Actions>
</Task>
`;
}
