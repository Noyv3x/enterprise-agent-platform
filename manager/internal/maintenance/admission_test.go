package maintenance

import "testing"

func TestAdmissionEpochAdvancesAtEveryPublicationBoundary(t *testing.T) {
	var admission Admission
	if got := admission.Epoch(); got != 0 {
		t.Fatalf("initial epoch = %d, want 0", got)
	}
	admission.Lock()
	if got := admission.Epoch(); got != 0 {
		t.Fatalf("locked epoch = %d, want 0", got)
	}
	admission.Unlock()
	if got := admission.Epoch(); got != 1 {
		t.Fatalf("published epoch = %d, want 1", got)
	}
}
