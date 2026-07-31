//go:build linux

package handofftransform

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

const privilegedProtocolSchema = 1

type privilegedWorkerRequest struct {
	SchemaVersion     int                     `json:"schema_version"`
	Operation         PrivilegedOperation     `json:"operation"`
	TransactionID     string                  `json:"transaction_id"`
	DataRequestSHA256 string                  `json:"data_request_sha256"`
	ResourceName      string                  `json:"resource_name"`
	Access            AccessClass             `json:"access"`
	ImageDigest       string                  `json:"image_digest"`
	ManagerUID        uint32                  `json:"manager_uid"`
	ManagerGID        uint32                  `json:"manager_gid"`
	TargetRelative    string                  `json:"target_relative,omitempty"`
	SourceOwners      []Owner                 `json:"source_owners"`
	TargetOwners      []Owner                 `json:"target_owners"`
	ExpectedSource    []Entry                 `json:"expected_source,omitempty"`
	ExpectedTarget    []Entry                 `json:"expected_target,omitempty"`
	RemovalProof      *PrivilegedRemovalProof `json:"removal_proof,omitempty"`
	RequestSHA256     string                  `json:"request_sha256"`
}

type privilegedWorkerReceipt struct {
	SchemaVersion     int                 `json:"schema_version"`
	Operation         PrivilegedOperation `json:"operation"`
	TransactionID     string              `json:"transaction_id"`
	DataRequestSHA256 string              `json:"data_request_sha256"`
	ResourceName      string              `json:"resource_name"`
	ImageDigest       string              `json:"image_digest"`
	RequestSHA256     string              `json:"request_sha256"`
	Entries           []Entry             `json:"entries,omitempty"`
	EntriesSHA256     string              `json:"entries_sha256,omitempty"`
	SourceEntries     []Entry             `json:"source_entries,omitempty"`
	SourceSHA256      string              `json:"source_sha256,omitempty"`
	TargetEntries     []Entry             `json:"target_entries,omitempty"`
	TargetSHA256      string              `json:"target_sha256,omitempty"`
	Removed           bool                `json:"removed"`
	ReceiptSHA256     string              `json:"receipt_sha256"`
}

func zeroRemovalProof(proof PrivilegedRemovalProof) bool {
	return proof == (PrivilegedRemovalProof{})
}

func cloneRemovalProof(proof PrivilegedRemovalProof) *PrivilegedRemovalProof {
	if zeroRemovalProof(proof) {
		return nil
	}
	copy := proof
	return &copy
}

func validateRemovalProof(proof PrivilegedRemovalProof) error {
	if !sha256Pattern.MatchString(proof.MarkerSHA256) {
		return errors.New("privileged removal proof has no exact staging marker digest")
	}
	switch proof.Kind {
	case RemovalStagingMarker:
		if proof.ManifestSHA256 != "" || proof.FenceBindingSHA256 != "" {
			return errors.New("staging removal proof carries publication authority")
		}
	case RemovalFencedPublication:
		if !sha256Pattern.MatchString(proof.ManifestSHA256) || !sha256Pattern.MatchString(proof.FenceBindingSHA256) {
			return errors.New("published removal proof lacks manifest or writer-fence binding")
		}
	default:
		return errors.New("privileged removal proof kind is invalid")
	}
	return nil
}

func sealPrivilegedRequest(request privilegedWorkerRequest) (privilegedWorkerRequest, error) {
	request.RequestSHA256 = ""
	digest, err := canonicalSHA256(request)
	if err != nil {
		return privilegedWorkerRequest{}, err
	}
	request.RequestSHA256 = digest
	return request, nil
}

func verifyPrivilegedRequest(request privilegedWorkerRequest) error {
	claimed := request.RequestSHA256
	if !sha256Pattern.MatchString(claimed) {
		return errors.New("privileged request has an invalid digest")
	}
	sealed, err := sealPrivilegedRequest(request)
	if err != nil {
		return err
	}
	if sealed.RequestSHA256 != claimed {
		return errors.New("privileged request digest mismatch")
	}
	return nil
}

func sealPrivilegedReceipt(receipt privilegedWorkerReceipt) (privilegedWorkerReceipt, error) {
	receipt.ReceiptSHA256 = ""
	digest, err := canonicalSHA256(receipt)
	if err != nil {
		return privilegedWorkerReceipt{}, err
	}
	receipt.ReceiptSHA256 = digest
	return receipt, nil
}

func verifyPrivilegedReceipt(request privilegedWorkerRequest, receipt privilegedWorkerReceipt) error {
	if receipt.SchemaVersion != privilegedProtocolSchema || receipt.Operation != request.Operation ||
		receipt.TransactionID != request.TransactionID || receipt.DataRequestSHA256 != request.DataRequestSHA256 ||
		receipt.ResourceName != request.ResourceName || receipt.ImageDigest != request.ImageDigest ||
		receipt.RequestSHA256 != request.RequestSHA256 || !sha256Pattern.MatchString(receipt.ReceiptSHA256) {
		return errors.New("privileged receipt identity differs from its request")
	}
	claimed := receipt.ReceiptSHA256
	sealed, err := sealPrivilegedReceipt(receipt)
	if err != nil {
		return err
	}
	if sealed.ReceiptSHA256 != claimed {
		return errors.New("privileged receipt digest mismatch")
	}
	if err := verifyEntryDigest(receipt.Entries, receipt.EntriesSHA256, "inventory"); err != nil {
		return err
	}
	if err := verifyEntryDigest(receipt.SourceEntries, receipt.SourceSHA256, "source"); err != nil {
		return err
	}
	if err := verifyEntryDigest(receipt.TargetEntries, receipt.TargetSHA256, "target"); err != nil {
		return err
	}
	return nil
}

func entryDigest(entries []Entry) (string, error) {
	if len(entries) == 0 {
		return "", nil
	}
	return canonicalSHA256(entries)
}

func verifyEntryDigest(entries []Entry, claimed, label string) error {
	digest, err := entryDigest(entries)
	if err != nil {
		return err
	}
	if digest != claimed {
		return fmt.Errorf("privileged %s inventory digest mismatch", label)
	}
	return nil
}

func canonicalSHA256(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}
